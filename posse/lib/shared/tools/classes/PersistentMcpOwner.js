// Persistent MCP owner for provider-launched stdio shims. Policy, evidence
// projection, and telemetry helpers live beside the session lifecycle owner.

import { COMPACT_RELATIONSHIP_PROJECTION } from "../../../catalog/atlas-presentation.js";
import { filterToolsListMessage, toolsListError, recordToolsListFailure, recordProviderIssuedToolSurface } from "../functions/mcp-owner-tool-surface.js";
import { appendResearcherSymbolHandles, researcherStructureExecutorArgs, researcherStructureProjection, structureMaxChars, compactResearcherTypedAtlasResult, normalizeResearcherTypedAtlasResultFieldNames } from "../functions/mcp-owner-atlas-presentation.js";
import "../functions/ref-surface.js";
export { __testResearcherStructureExecutorArgs, __testResearcherStructureProjection, __testStructureMaxChars } from "../functions/mcp-owner-atlas-presentation.js";
import { routeResearcherDispatcherCall, noteResearcherTypedTraversalPromotion } from "../functions/mcp-owner-atlas-routing.js";
export { __testRouteResearcherDispatcherCall } from "../functions/mcp-owner-atlas-routing.js";
import { MCP_ATLAS_SOFT_CAP_FIELDS, DEFAULT_MCP_OAUTH_TTL_SECONDS, MCP_SESSION_RELEASED_NOTIFICATION, MCP_CONCURRENT_ATLAS_ACTIONS, MCP_CONTROL_METHODS, MCP_OWNER_PROGRESS_HEADER, MCP_OWNER_HEARTBEAT_INTERVAL_MS, MCP_TERMINAL_HANDOFF_TOOLS, POSSE_MCP_GATEWAY_SERVER_NAME } from "../../../catalog/mcp.js";
import { codexSoftCheckpoint } from "../functions/codex-soft-checkpoint.js";
import { notePlannerTriageCall, reservePlannerRead, appendPlannerTriageNotice, isResearchPhysicalWorkRequest, mcpToolCallSuccess, appendToolResultText, recordOwnerModelControlNotice, effectiveAtlasResearchAction, appendOwnerModelControlNotice, attachTelemetryContext, OWNER_MODEL_CONTROL_NOTICES } from "../functions/planner-triage.js";
import { beginToolInvocation, recordObservation, isResearchInfrastructureFailure, RESEARCH_INFRASTRUCTURE_REFUND_LIMIT, researchExplorationObservationStatus, researchChildBudgetCallId } from "../../../domains/observability/functions/observations.js";
import { RESEARCH_CITATION_FETCH_GATE_ENABLED, RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS, RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS, RESEARCH_SYNTHESIS_MIN_EXPLORATION_STEPS, RESEARCH_SYNTHESIS_STALE_EXPLORATION_STEPS, buildResearchWorkBudgetExhaustedText, buildResearchWorkBudgetRemainingText, buildResearchCitationFetchGateText, buildResearchCurtainCallText, buildResearchEarlyFetchBatchingText, buildResearchFinalFetchBatchText, buildResearchFinalSlotLimitText, buildResearchSynthesisRequiredText, isResearchAtlasCitationFetchAction, isResearchAtlasExplorationAction, researchSynthesisDecision, researchSynthesisExplorationCeiling, validateResearchWorkBudgetCalls } from "../../../domains/integrations/functions/deterministic-mcp/research-synthesis.js";
import { resolveAtlasResearchRuntimeGuidance, resolveResearchBudgetVisibility, resolveResearchSynthesisPolicySnapshot } from "../../../domains/integrations/functions/deterministic-mcp/gate-settings.js";
import { omitAtlasCacheMetadata } from "../functions/atlas-agent-result.js";
import { listHashRefTraversalsForContext } from "../../../domains/queue/functions/hash-refs.js";
import { atlasDescriptorSchemaForAction } from "../../../domains/atlas/functions/v2/contracts/tool-schemas.js";
import { hashRefToolContext, capString, cloneJson, gatewayGateBindingKey, mcpToolErrorPayload, ownerErrorSummary, toolsListCount, jsonlParseBuffer } from "../functions/mcp-owner-session-support.js";
import crypto from "node:crypto";
import { getAgentHandoffRecord, getTraversalCompletionSnapshotForCall, recordAgentHandoffRejection, rejectAgentHandoffForLaterTool } from "../../../domains/handoff/functions/agent-handoff.js";
import { validateToolArguments } from "../functions/schema-validation.js";
import { validationFailureForAction } from "../../../domains/atlas/functions/v2/retrieval/dispatch.js";
import { appendResearchWorkBudget, researchWorkBudget } from "../../../domains/research/functions/work-budget.js";
import { renderAgentHandoffCallableName } from "../functions/mcp-surface.js";
import { getAtlasIntegrationConfig } from "../../../domains/integrations/functions/atlas/config.js";
import { compactCodeStructureResult, compactCodeSurveyResult } from "../functions/atlas-result-paging.js";
import { appendHashRefIfMajor, compactCodeWindowLensResult, createHashRefResult, fetchHashRefTool, hashRefTraversalInputs } from "../functions/hash-adder.js";
import { operatorFeedbackDeliveryForJob, operatorFeedbackDeliveryText } from "../../../domains/providers/functions/shared/operator-feedback-delivery.js";
import { randomToken, defaultPipePath, sendJson, readJsonBody, bearerFrom, tokenEqual, tokenHash } from "../functions/mcp-owner-transport.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { bootConfigFromMcpOAuthClaims, mintMcpOAuthTokenForBootConfig, verifyMcpOAuthToken } from "../../../domains/integrations/functions/deterministic-mcp/oauth-token.js";
import { bindAgentAttachmentToSignedContract, narrowBootConfigToSignedClaims } from "../functions/issued-tool-policy.js";
import { PersistentMcpSession } from "./PersistentMcpSession.js";
import { appendRunTelemetry } from "../../telemetry/functions/run-telemetry.js";
import { flushSharedAtlasToolExecutorDeferredRefreshes, getSharedAtlasToolExecutor } from "../../../domains/atlas/functions/v2/tools/executor.js";
import { NativeAuthHandshake } from "../../native/classes/NativeAuthHandshake.js";
import { ContextMeter } from "../../classes/ContextMeter.js";
import { AGENT_HANDOFF_RECEIPT_NOTIFICATION } from "../../../catalog/handoff.js";
import { agentHandoffTerminator } from "../../../domains/handoff/classes/AgentHandoffTerminator.js";
import { acknowledgeWebResearchHandoffReceipt } from "../../../domains/web-research/classes/WebResearchRuntime.js";
import { teamManagedToolAdmitted } from "../../../domains/pairing/functions/team-managed-write.js";
import { finalReviewPassedForCall } from "../../../domains/assessment/functions/final-review-result.js";
import { executeFinalReview, finalReviewRuntime } from "../../../domains/assessment/classes/FinalReviewRuntime.js";
import { assessorToolBudgetApplies, assessorToolCallCeilingDecision } from "../functions/assessor-tool-budget.js";
import { assessorFallbackReadKey, isAssessorFallbackReadKey } from "../../../domains/assessment/functions/fallback-read-tools.js";
import { assertSubAgentParentReady, executeSubAgent, executeSubAgentNextInput, prepareSubAgentHandoff, sealSubAgentHandoff, subAgentCompletionSignal } from "../../../domains/sub-agent/classes/SubAgentRuntime.js";
import { AutomationOwnerClient } from "../../../domains/automation/classes/AutomationOwnerClient.js";
import { CUSTOM_TOOLS_AGENT_REQUEST_TIMEOUT_MS } from "../../../catalog/custom-tools.js";
import { executeDispatchAgent, submitWebResearchHandoff } from "../../../domains/web-research/classes/WebResearchRuntime.js";
import { FINAL_REVIEW_REVIEWER_STATUS } from "../../../catalog/final-review.js";
import { jobWriteActivity } from "../../../domains/scheduler/classes/JobWriteActivity.js";
import { materializeDisplayedSourceCoverage, numberedReadCoverageHunks, searchResultCoverageHunks, sourceCoverageIsSuppressive, prepareSourceCoverage, sourceCoverageOwnerForSession, suppressCoveredSourceInterval } from "../../../domains/research/functions/owner-source-admission.js";
import { observeAtlasRequest } from "../functions/atlas-request-observation.js";
import { isSymbolGetBatch, planSymbolGetBatch, combineSymbolGetBatchResults } from "../../../domains/atlas/functions/v2/retrieval/symbol-get-batch.js";
import { observeAtlasExecution } from "../functions/atlas-result-status.js";
import { roleUsesBoundedRefTraversal } from "../../../catalog/tool-surface/ref-traversal.js";
import { sourceSelectorFingerprint } from "../../../domains/research/classes/SourceCoverageOwner.js";
import { admitSourceContextHeadroom, releaseSourceContextHeadroomReservation } from "../../../domains/research/functions/context-headroom.js";
import { compactResearchSearchResult, compactResearchSearchRows } from "../functions/research-search-presentation.js";
import { ATLAS_MUTATION_PATH_FIELDS } from "../../../catalog/tools/filesystem-mutations.js";
import { usesResearcherAtlasReadSurface, sessionToolPolicy, requestedToolPolicyName, toolAllowedByPolicy, stripGatewaySessionTokenFields, nestedAtlasActionDenial, deniedToolCallMessage, hasSuiteToolAllowlist, delegatedEvidenceRequestAllowed } from "../functions/mcp-owner-tool-policy.js";
import { resolveAtlasSymbolHandle, atlasSymbolSourcePath } from "../functions/mcp-owner-symbol-handles.js";
import { annotateOwnerResultTransform, preserveOwnerModelControlNotices, ownerExactSourceEvidence, ownerThinImplementationGap, tagOwnerModelControlNotice, isMemoryToolAction, finalizeSourceTransport, mcpResultTextChars, CLIENT_RESULT_CLIP_CHARS } from "../functions/mcp-owner-source-transport.js";
import { recordOwnerToolObservation, recordOwnerAnsweredToolCall, ownerToolStructuredError } from "../functions/mcp-owner-tool-observations.js";
import { admissionMaxPhysicalCalls, researchCeilingGraceDecision, researchCeilingEmissionFor, isTerminalResearchExplorationAdmission } from "../functions/mcp-owner-research-budget.js";
import { subAgentRoutingEnabled, subAgentRoutingBlockReason, subAgentRoutingContext, subAgentRoutingGuardResult, subAgentInputObservationDetails, subAgentObservationResults, noteSubAgentRoutingSuccess } from "../functions/mcp-owner-sub-agent-routing.js";
import { sameFileAmbiguityBatchItems, emptyIdentifierFilterRecovery, IDENTIFIER_FILTER_FIELDS, lensDirectoryTarget, withNestedAtlasAction, exactNameSearchQuery, exactNameSearchTarget, nearestNameSearchArgs, searchResultItems, clampAtlasArgumentCeilings } from "../functions/mcp-owner-atlas-recovery.js";
import { recordSourceSelectionObservations, sourceSelectionItems, sourceSelectionCoverageCursor, coveredSourceSelectionObservation, suppressedSourceSelectionObservation } from "../functions/mcp-owner-evidence.js";
export { __testSubAgentObservationResults, __testSubAgentInputObservationDetails, __testSubAgentRoutingGuardResult, __testSubAgentRoutingSequence, __testSubAgentRoutingEnabled } from "../functions/mcp-owner-sub-agent-routing.js";
export { __testDelegatedEvidenceRequestAllowed, __testAssessorFallbackReadKey, __testNestedAtlasActionDenial, __testDeniedToolCallMessage } from "../functions/mcp-owner-tool-policy.js";
export { __testClampAtlasArgumentCeilings, __testSameFileAmbiguityBatchItems, __testEmptyIdentifierFilterRecovery, __testLensDirectoryTarget, __testExactNameSearchTarget, __testNearestNameSearchArgs } from "../functions/mcp-owner-atlas-recovery.js";
export { __testRememberAtlasSymbolSourcePaths } from "../functions/mcp-owner-symbol-handles.js";
export { __testOwnerAtlasPartialResultDiagnostic, __testFinalizeSourceTransport, __testPreserveOwnerModelControlNotices } from "../functions/mcp-owner-source-transport.js";
export { __testOwnerSourceRangeEvidence, __testOwnerWindowResponseRangeEvidence } from "../functions/mcp-owner-evidence.js";

export { __testPlannerTriageSequence } from "../functions/planner-triage.js";
export { __testShortenUnixSocketPath } from "../functions/mcp-owner-transport.js";

const SOURCE_EVIDENCE_REUSE_NOTICE_KIND = "source_evidence_reuse";
const sourceEvidenceReuseNoticeAttempts = new WeakMap();
const symbolCallerPageVersions = new WeakMap();
// Codex can emit one read batch but dispatch it through the MCP transport in
// several short waves. Keep the final admitted emission alive across the
// zero-active gap between those waves; a later model turn takes materially
// longer and is admitted against the now-closed durable research lane.
const RESEARCH_ATLAS_TERMINAL_BATCH_IDLE_MS = 250;

/** @param {any} session @param {string} requestedName @param {Record<string, any>} args */
function compactCallerExecutorArgs(session, requestedName, args = {}) {
  if (requestedName !== "symbol.callers") return args;
  const compact = /** @type {Record<string, any>} */ ({ ...args, projection: COMPACT_RELATIONSHIP_PROJECTION });
  const offset = Math.max(0, Number(compact.offset) || 0);
  if (offset === 0 || !session || typeof session !== "object") return compact;
  const key = [compact.symbolId, compact.mode || "caller", compact.minConfidence ?? 0].join("\u0000");
  const expected = symbolCallerPageVersions.get(session)?.get(key);
  return expected ? { ...compact, indexVersion: expected } : compact;
}

/** @param {any} session @param {string} requestedName @param {Record<string, any>} args @param {any} result */
function rememberCompactCallerPageVersion(session, requestedName, args, result) {
  if (requestedName !== "symbol.callers" || !session || typeof session !== "object"
    || result?.isError === true) return;
  const first = Array.isArray(result?.content) ? result.content.find((entry) => entry?.type === "text") : null;
  let parsed;
  try { parsed = JSON.parse(String(first?.text || "")); } catch { return; }
  const indexVersion = String(parsed?._meta?.pagination?.indexVersion || "").trim();
  if (!indexVersion) return;
  const key = [args?.symbolId, args?.mode || "caller", args?.minConfidence ?? 0].join("\u0000");
  const pages = symbolCallerPageVersions.get(session) || new Map();
  pages.set(key, indexVersion);
  symbolCallerPageVersions.set(session, pages);
}
export const __testCompactCallerExecutorArgs = compactCallerExecutorArgs;

export const __testRememberCompactCallerPageVersion = rememberCompactCallerPageVersion;
const CONCURRENT_RESEARCH_ATLAS_ACTIONS = new Set(MCP_CONCURRENT_ATLAS_ACTIONS);

// Applied once to the response the provider receives, never to an inner
// execution a recovery may replace or to a batch item, so a consumed
// checkpoint is always a delivered one.
function appendCodexSoftCheckpoint(response, session, toolName) {
  if (!response?.result || response.result.isError === true) return response;
  let checkpoint;
  try { checkpoint = codexSoftCheckpoint(session); } catch { return response; }
  if (!checkpoint) return response;
  const updated = appendToolResultText(response, checkpoint.text, {
    kind: "codex_soft_checkpoint", trigger: checkpoint.trigger,
  });
  if (updated === response) session._codexSoftCheckpointCallId = null;
  if (updated !== response) recordOwnerModelControlNotice(session, toolName, {
    kind: "codex_soft_checkpoint", text: checkpoint.text, trigger: checkpoint.trigger,
  });
  return updated;
}

function researchBudgetKey(boot = {}) {
  return [boot.jobId ?? "no-job", boot.attemptId ?? "no-attempt", researchChildBudgetCallId(boot.agentCallId) || "parent"].join(":");
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
      budgetExhausted: false,
      thinImplementationGaps: 0,
    };
    researchNoticeFlagState.set(key, flags);
    while (researchNoticeFlagState.size > RESEARCH_NOTICE_FLAG_LIMIT) {
      researchNoticeFlagState.delete(researchNoticeFlagState.keys().next().value);
    }
  }
  return flags;
}

// P0.2: one frozen research admission policy per job/attempt. Reservations,
// admission, closing warnings, telemetry, and the terminal gate all read the
// same snapshot, so a setting or environment change cannot move the physical
// rail between two calls of one attempt. Keyed like the notice flags because a
// gateway restart recreates session objects for the same attempt.
const RESEARCH_POLICY_SNAPSHOT_LIMIT = 2000;
const researchPolicySnapshots = new Map();
function researchWorkBudgetCallsFor(boot = {}) {
  return String(boot.role || "") === "researcher"
    ? validateResearchWorkBudgetCalls(boot.researchWorkBudgetCalls)
    : null;
}

function researchSynthesisPolicyFor(session) {
  const boot = session?.bootConfig || {};
  // A research child's granted retrieval budget lowers its own rail; the key
  // carries it so a child can never share a parent's snapshot.
  const workBudgetCalls = researchWorkBudgetCallsFor(boot);
  const key = workBudgetCalls == null
    ? researchBudgetKey(boot)
    : `${researchBudgetKey(boot)}:budget-${workBudgetCalls}`;
  let policy = researchPolicySnapshots.get(key);
  if (!policy) {
    policy = resolveResearchSynthesisPolicySnapshot({ workBudgetCalls });
    researchPolicySnapshots.set(key, policy);
    while (researchPolicySnapshots.size > RESEARCH_POLICY_SNAPSHOT_LIMIT) {
      researchPolicySnapshots.delete(researchPolicySnapshots.keys().next().value);
    }
  }
  return policy;
}

export function __testResearchSynthesisPolicyFor(session) {
  return researchSynthesisPolicyFor(session);
}

export function __testResetResearchSynthesisPolicySnapshots() {
  researchPolicySnapshots.clear();
}

function projectAtlasModelResult(result, session, toolName, toolArgs = {}) {
  const projected = normalizeResearcherTypedAtlasResultFieldNames(
    omitAtlasCacheMetadata(result), session, toolName, toolArgs,
  );
  const capped = toolArgs && typeof toolArgs === "object" ? SOFT_CAPPED_ARGUMENTS.get(toolArgs) : null;
  return capped
    ? appendOwnerModelControlNotice(projected, `\n\n${capped}`, { kind: "atlas_soft_cap", trigger: toolName })
    : projected;
}

// A list argument over its schema cap is truncated to the cap, not refused: a
// refusal spends a whole call on nothing (atlas555 PY_HTTPX_3 sent code.survey
// 20 identifiers against a cap of 16). The result says what was dropped.
const SOFT_CAPPED_ARGUMENTS = new WeakMap();
const SOFT_CAP_FIELDS = new Set(MCP_ATLAS_SOFT_CAP_FIELDS);

function softCapArrayArguments(schema, toolArgs) {
  if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return;
  const properties = schema?.properties || {};
  const notes = [];
  for (const [field, value] of Object.entries(toolArgs)) {
    const limit = properties[field]?.maxItems;
    if (!SOFT_CAP_FIELDS.has(field) || !Array.isArray(value) || !Number.isSafeInteger(limit) || value.length <= limit) continue;
    toolArgs[field] = value.slice(0, limit);
    notes.push(`${field} listed ${value.length} entries; the first ${limit} were used and ${value.slice(limit).join(", ")} were not.`);
  }
  if (notes.length > 0) SOFT_CAPPED_ARGUMENTS.set(toolArgs, notes.join(" "));
}

export const __testProjectAtlasModelResult = projectAtlasModelResult;

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

function recordDeniedToolCall(session, toolName, args, policy, message, override = null) {
  const boot = session?.bootConfig || {};
  if (boot.attemptId == null) return;
  const denial = nestedAtlasActionDenial(policy, toolName, args);
  const requested = requestedToolPolicyName(toolName, args);
  try {
    // Deliberately outside the `tool.*` namespace: a policy rejection is an
    // issued request that never executed and must not count as a physical
    // call in any tool-mix summary.
    const rejectionCode = String(override?.code || denial?.code || "tool_not_allowed");
    const rejectionReason = String(override?.reason || "").trim();
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId,
      observation_type: "research.action_rejected",
      summary: rejectionReason
        ? `Research action rejected: ${rejectionCode} ${rejectionReason}`
        : denial
        ? `Nested Atlas action rejected: ${denial.code} ${denial.action}`
        : `Tool rejected by session policy: ${toolName || "(unknown)"}`,
      detail: {
        kind: "tool_policy_rejection",
        code: rejectionCode,
        tool: toolName || null,
        suite: requested.suite,
        action: denial?.action || requested.nested || requested.name || null,
        replacement: denial?.replacement || null,
        ...(rejectionReason ? { reason: rejectionReason } : {}),
        policy_source: policy?.source || null,
        mcp_request_id: message?.id ?? null,
        agent_call_id: boot.agentCallId ?? null,
        physical_request: 1,
        executed: false,
      },
    });
  } catch { /* telemetry only */ }
  try {
    const rejectionCode = String(override?.code || denial?.code || "tool_not_allowed");
    const rejectionReason = String(override?.reason || "").trim();
    const result = rejectionReason
      ? mcpToolErrorPayload(rejectionReason, {
          code: rejectionCode,
          message: rejectionReason,
        })
      : deniedToolCallMessage(message, toolName, policy, args)?.result;
    recordOwnerToolObservation({
      session,
      toolName,
      toolArgs: args,
      result,
      outcomeOverride: "rejected",
      executor: { via: "session_tool_policy" },
      observationDetail: {
        executed: false,
        consumed_step: false,
        policy_rejected: true,
        rejection_code: rejectionCode,
      },
    });
  } catch { /* telemetry only */ }
}

export function __testMcpToolErrorPayload(message, error = null, options = {}) {
  return mcpToolErrorPayload(message, error, options);
}

function mcpToolTextPayload(text) {
  const value = String(text || "");
  return {
    content: [{ type: "text", text: value }],
    isError: /^Error:/i.test(value),
  };
}

/**
 * @param {{
 *   session?: any,
 *   toolName?: string,
 *   toolArgs?: Record<string, any>,
 *   reason?: string|null,
 *   text?: string|null,
 *   used?: number|null,
 *   cap?: number|null,
 * }} [input]
 */
function recordOwnerAssessorBudgetExhaustion({
  session,
  toolName,
  toolArgs,
  reason,
  text,
  used,
  cap,
} = {}) {
  const error = {
    code: "assessor_tool_budget_exhausted",
    message: String(text || "Assessor tool budget exhausted"),
    details: { reason, used, cap },
  };
  recordOwnerToolObservation({
    session,
    toolName,
    toolArgs,
    result: mcpToolErrorPayload(error.message, error),
    durationMs: 0,
    observationDetail: {
      assessment_budget_exhausted: true,
      assessment_budget_reason: reason,
      assessment_budget_used: used,
      assessment_budget_cap: cap,
      tool_name: toolName,
      transport: "mcp_owner",
    },
  });
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

function ownerTraversalCompletionForNotice(session, completionOverride = undefined) {
  if (completionOverride !== undefined) return completionOverride;
  const boot = session?.bootConfig || {};
  return getTraversalCompletionSnapshotForCall({
    jobId: boot.jobId ?? null,
    attemptId: boot.attemptId ?? null,
  });
}

function appendOwnerThinImplementationGapNotice(
  result,
  session,
  requested,
  completionOverride = undefined,
  evidenceResultOverride = null,
) {
  if (result?.isError === true || !["code.window", "symbol.get"].includes(requested?.name)) return result;
  if (!resolveAtlasResearchRuntimeGuidance()) return result;
  const flags = researchNoticeFlagsFor(session);
  if (Number(flags.thinImplementationGaps || 0) >= 2) return result;
  const completion = ownerTraversalCompletionForNotice(session, completionOverride);
  if (completion?.active !== true) return result;
  const evidence = ownerExactSourceEvidence(evidenceResultOverride || result);
  if (!ownerThinImplementationGap(evidence.source)) return result;
  flags.thinImplementationGaps = Number(flags.thinImplementationGaps || 0) + 1;
  const notice = "IMPLEMENTATION STATUS: declaration_only. The returned source contains no executable body.";
  return appendOwnerModelControlNotice(result, `\n\n${notice}`, {
    kind: "research_thin_implementation_gap",
    trigger: "exact_symbol_without_governing_body",
  });
}

export const __testAppendOwnerThinImplementationGapNotice = appendOwnerThinImplementationGapNotice;

function researcherTypedArgumentRepair(session, toolName, toolArgs = {}) {
  if (!usesResearcherAtlasReadSurface(sessionToolPolicy(session))) return null;
  const requested = requestedToolPolicyName(toolName, toolArgs);
  if (requested.suite !== "atlas" || !requested.name || requested.name === "query") return null;
  const schema = atlasDescriptorSchemaForAction(requested.name);
  if (!schema) return null;
  softCapArrayArguments(schema, toolArgs);
  const validation = validateToolArguments({ parameters: schema }, toolArgs);
  if (validation.ok) return null;
  const failure = requested.name === "code.window"
    ? validationFailureForAction(
        requested.name,
        { action: requested.name, ...toolArgs },
        validation.errors,
      )
    : null;
  const missingSymbolSelector = requested.name === "symbol.get"
    && !String(toolArgs?.symbolId || "").trim()
    && !(toolArgs?.symbolRef && typeof toolArgs.symbolRef === "object"
      && !Array.isArray(toolArgs.symbolRef) && String(toolArgs.symbolRef.name || "").trim());
  const nativeProblem = missingSymbolSelector
    ? "args.symbolId or args.symbolRef is required"
    : String(failure?.message || validation.message || "the selected action arguments are invalid");
  const problem = nativeProblem.replace(/\b(?:maxFiles|maxLines|symbols|fileRelPaths|search_mode)\b/gu, (field) => {
    if (field === "maxFiles" && ["code.survey", "code.structure"].includes(requested.name)) return "limit";
    if (field === "maxLines" && requested.name === "code.skeleton") return "limit";
    if (field === "symbols" && requested.name === "code.survey") return "identifiersToFind";
    if (field === "fileRelPaths" && requested.name.startsWith("memory.")) return "paths";
    if (field === "search_mode" && requested.name === "traverse_ref") return "searchMode";
    return field;
  });
  if (!resolveAtlasResearchRuntimeGuidance()) {
    const error = {
      code: "invalid_params",
      message: problem,
      ...(failure?.details ? { details: failure.details } : {}),
    };
    const base = mcpToolErrorPayload(problem, error);
    return {
      result: {
        ...base,
        _meta: {
          ...(base._meta || {}),
          posseArgumentRepair: {
            version: 1,
            action: requested.name,
            problem,
            nativeExecuted: false,
          },
        },
      },
      problem,
      action: requested.name,
    };
  }
  const text = [
    `ATLAS ARGUMENT REPAIR: ${requested.name} was not executed because ${problem}.`,
    `Retry ${requested.name} once with every required selector and the correct field types; do not reuse an empty args or parameters object.`,
    "This control response contains no repository evidence.",
  ].join("\n");
  const result = tagOwnerModelControlNotice({
    content: [{ type: "text", text }],
    isError: false,
    _meta: {
      posseControlOnly: true,
      posseArgumentRepair: {
        version: 1,
        action: requested.name,
        problem,
        nativeExecuted: false,
      },
    },
  }, text, {
    kind: "research_argument_repair",
    trigger: "typed_dispatcher_schema_validation",
  });
  return { result, problem, action: requested.name };
}

export function __testResearcherTypedArgumentRepair(session, toolName, toolArgs = {}) {
  return researcherTypedArgumentRepair(session, toolName, toolArgs);
}

function sourceEvidenceReuseNotice(coverageOwner, admission) {
  if (!resolveAtlasResearchRuntimeGuidance()) return null;
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

function resolvedCoverageSuppressionNotice(coverageOwner, suppression) {
  if (!resolveAtlasResearchRuntimeGuidance() || !suppression?.admission) return null;
  return suppression.reuseNotice || sourceEvidenceReuseNotice(
    coverageOwner,
    suppression.admission,
  );
}

export function __testResolvedCoverageSuppressionNotice(coverageOwner, suppression) {
  return resolvedCoverageSuppressionNotice(coverageOwner, suppression);
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
  physicalCeilingGrace = false,
  sameStepRecovery = false,
} = {}) {
  const boot = session?.bootConfig || {};
  const policy = researchSynthesisPolicyFor(session);
  // A recovery re-read runs inside a call that was already admitted on this
  // step. That call recorded the step, so a closeout derived from the recorded
  // count would block the re-read of the very content the call asked for
  // (Atlas594 TS_TYPEORM_1: every recovered body on step 26 came back blocked).
  // The physical ceiling still applies to the step itself.
  const recoveryOnAdmittedStep = sameStepRecovery === true && Number.isSafeInteger(assignedPhysicalCallStep);
  const citationFetch = RESEARCH_CITATION_FETCH_GATE_ENABLED
    && isResearchAtlasCitationFetchAction(requestedAction);
  const exploration = isResearchAtlasExplorationAction(requestedAction);
  if (String(boot.role || "") !== "researcher" || (!exploration && !citationFetch)) {
    return {
      tracked: false,
      blocked: false,
      explorationSteps: 0,
      callSteps: 0,
      maxPhysicalCalls: policy.maxPhysicalCalls,
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
    agentCallId: boot.agentCallId ?? null,
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
    maxPhysicalCalls: policy.maxPhysicalCalls,
  });
  if (citationFetch) {
    const synthesisRequired = progressDecision.required;
    const assignedCallStep = Number.isSafeInteger(assignedPhysicalCallStep)
      ? assignedPhysicalCallStep
      : Math.max(0, Number(status.call_steps || 0)) + 1;
    const assignedPhysicalCeiling = physicalCeilingGrace !== true && assignedCallStep > policy.maxPhysicalCalls;
    const finalFetchAlreadyUsed = !recoveryOnAdmittedStep && synthesisRequired && citationFetchBatches >= 1;
    return {
      tracked: true,
      maxPhysicalCalls: policy.maxPhysicalCalls,
      physicalCeilingGrace: physicalCeilingGrace === true,
      blocked: assignedPhysicalCeiling || finalFetchAlreadyUsed,
      blockReason: assignedPhysicalCeiling
        ? "physical_call_ceiling"
        : (finalFetchAlreadyUsed ? "budget_exhausted" : null),
      citationFetch: true,
      citationFetches,
      citationFetchBatches,
      fetchBatchesTotal,
      explorationFetchBatches,
      singletonFetchBatches,
      multiFetchBatches,
      explorationSteps: Math.max(0, Number(status.exploration_steps || 0)),
      callSteps: Math.min(
        policy.maxPhysicalCalls,
        Math.max(0, Number(status.call_steps || 0), assignedCallStep - 1),
      ),
      assignedPhysicalCallStep: assignedCallStep,
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
  const pastPhysicalCeiling = assignedCallStep > policy.maxPhysicalCalls;
  // A graced sibling of the exhausting emission executes, but the budget is
  // still spent: synthesis stays required and the closeout notice still lands.
  const assignedPhysicalCeiling = physicalCeilingGrace !== true && pastPhysicalCeiling;
  const assignedAbsoluteCeiling = assignedUnitCeiling || assignedPhysicalCeiling;
  return {
    tracked: true,
    maxPhysicalCalls: policy.maxPhysicalCalls,
    physicalCeilingGrace: physicalCeilingGrace === true,
    blocked: (!recoveryOnAdmittedStep && progressDecision.required) || assignedAbsoluteCeiling,
    blockReason: (!recoveryOnAdmittedStep && progressDecision.reason) || (assignedPhysicalCeiling
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
      policy.maxPhysicalCalls,
      Math.max(0, Number(status.call_steps || 0), assignedCallStep - 1),
    ),
    symbolFollowupsDiscounted: Math.max(0, Number(status.symbol_followups_discounted || 0)),
    staleSteps: Math.max(0, Number(status.stale_steps || 0)),
    lastNovelEvidenceStep: Math.max(0, Number(status.last_novel_evidence_step || 0)),
    assignedExplorationStep: assignedStep,
    assignedPhysicalCallStep: assignedCallStep,
    explorationUnitWeight: unitWeight,
    symbolFollowupDiscounted: symbolFollowupDiscounted === true,
    synthesisRequired: progressDecision.required || assignedAbsoluteCeiling || pastPhysicalCeiling,
    synthesisReason: progressDecision.reason || (pastPhysicalCeiling
      ? "physical_call_ceiling"
      : (assignedUnitCeiling ? "exploration_ceiling" : null)),
  };
}

function appendOwnerResearchFinalFetchNotice(result, admission, session = null) {
  if (!resolveAtlasResearchRuntimeGuidance()) return result;
  if (result?.isError === true || !admission?.citationFetch || admission.researchPhase !== "synthesis") return result;
  const notice = buildResearchFinalFetchBatchText({ handoffToolName: agentHandoffCallableName(session) });
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
  if (!resolveAtlasResearchRuntimeGuidance()) return result;
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

function recordOwnerResearchSynthesisRequired(session, progress = {}, toolName) {
  const boot = session?.bootConfig || {};
  const current = researchExplorationObservationStatus({
    jobId: boot.jobId ?? null,
    attemptId: boot.attemptId ?? null,
    agentCallId: boot.agentCallId ?? null,
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
  const policy = researchSynthesisPolicyFor(session);
  const decision = researchSynthesisDecision({
    explorationSteps,
    callSteps,
    staleSteps,
    maxPhysicalCalls: policy.maxPhysicalCalls,
  });
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
      max_exploration_steps: policy.maxExplorationSteps,
      physical_call_ceiling: policy.maxPhysicalCalls,
      last_novel_evidence_step: lastNovelEvidenceStep,
      relevant_files: null,
      irrelevant_files: null,
      reason: `exploration_steps=${explorationSteps}; stale_steps=${staleSteps}; stop_reason=${progress.synthesisReason || decision.reason || "owner_closeout"}; last_tool=${toolName}; source=mcp_owner`,
    },
  });
}

// With runtime guidance off the model otherwise learns of exhaustion only by
// spending a full-context turn on calls that return blocked (Atlas497: 12
// wholly blocked turns). Only the call holding the final slot carries it, and
// only while that slot is still reserved: an infrastructure refund runs first,
// so a refunded final call reports nothing. Error results consume a slot too.
// Batch items defer to the combined batch result; a per-attempt flag keeps
// the notice to one delivery across the Atlas, gateway, and batch paths.
// Within the last six calls every result states the live remaining count: a
// bare count, no handoff instruction. The instructed countdown read as an
// order to stop (Atlas528/530 left located code unread); with no count at
// all, Atlas531 sent 28 of 40 cells into the ceiling mid-batch (93 blocked
// calls). Stating it once was not enough: a parallel batch is admitted one
// call at a time, so an early sibling's count went stale as later siblings
// consumed slots (Atlas533 PY_FLASK_1 read "3 remain" with none left). The
// batch's last result now carries the true figure.
const RESEARCH_BUDGET_REMAINING_NOTICE_AT = 6;

// research_budget_visibility=always states the total and the live remaining
// count on every retrieval result instead of only in the closing window. One
// value per session, so a setting change mid-attempt cannot flip the notices.
function researchBudgetVisibilityFor(session) {
  if (!session || typeof session !== "object") return resolveResearchBudgetVisibility();
  session._researchBudgetVisibility ??= resolveResearchBudgetVisibility();
  return session._researchBudgetVisibility;
}

function appendResearchBudgetExhaustedNotice(result, admission, session) {
  if (resolveAtlasResearchRuntimeGuidance()) return result;
  if (!admission?.tracked || admission.blocked || admission.physicalBatchId) return result;
  const max = admissionMaxPhysicalCalls(admission);
  const remaining = researchWorkBudget(admission)?.remaining;
  if (!Number.isSafeInteger(remaining)) return result;
  if (remaining > 0) {
    const always = researchBudgetVisibilityFor(session) === "always";
    if (!always && remaining > RESEARCH_BUDGET_REMAINING_NOTICE_AT) return result;
    return appendOwnerModelControlNotice(result, `\n\n${buildResearchWorkBudgetRemainingText({ remaining, ...(always ? { limit: max } : {}) })}`, {
      kind: "research_budget_remaining",
      trigger: "physical_call_ceiling",
    });
  }
  if (!(Number(admission.assignedPhysicalCallStep) >= max)) return result;
  const flags = session ? researchNoticeFlagsFor(session) : null;
  if (flags?.budgetExhausted) return result;
  const next = appendOwnerModelControlNotice(result, `\n\n${researchWorkBudgetExhaustedText(session)}`, {
    kind: "research_budget_exhausted",
    trigger: "physical_call_ceiling",
  });
  if (next !== result && flags) flags.budgetExhausted = true;
  return next;
}

// The gateway and symbol.get batch paths append the budget notice outside the
// observed-tool path, so they record it here. Record the notice actually
// appended: within the countdown window that is research_budget_remaining
// with its live count, not the exhausted notice.
function appendAndRecordResearchBudgetNotice(result, admission, session, toolName) {
  const next = appendResearchBudgetExhaustedNotice(result, admission, session);
  if (next === result) return result;
  const prior = result?.[OWNER_MODEL_CONTROL_NOTICES]?.length || 0;
  for (const notice of (next?.[OWNER_MODEL_CONTROL_NOTICES] || []).slice(prior)) {
    recordOwnerModelControlNotice(session, toolName, { ...notice, text: String(notice.text || "").trim() });
  }
  return next;
}

export const __testAppendAndRecordResearchBudgetNotice = appendAndRecordResearchBudgetNotice;
export const __testResearchCeilingGraceDecision = researchCeilingGraceDecision;
export const __testResearchCeilingEmissionFor = researchCeilingEmissionFor;
export const __testOwnerResearchSynthesisAdmission = ownerResearchSynthesisAdmission;

function agentHandoffCallableName(session) {
  const boot = session?.bootConfig || {};
  return renderAgentHandoffCallableName({
    providerName: boot.providerName,
    agentHandoff: boot.agentHandoff === true,
    issuedTools: Array.isArray(boot.toolAllowlist?.tools) ? boot.toolAllowlist.tools : null,
    serverName: POSSE_MCP_GATEWAY_SERVER_NAME,
  });
}

function researchWorkBudgetExhaustedText(session) {
  return buildResearchWorkBudgetExhaustedText({ handoffToolName: agentHandoffCallableName(session) });
}

// Unguided blocked payloads state the same fact: a model that has already
// seen blocked siblings otherwise retries a whole batch (Atlas497: 5 of 12
// wholly blocked turns followed a turn with blocked results).
function unguidedResearchBlockedPayload(reason, session) {
  return mcpToolTextPayload(JSON.stringify({
    status: "blocked",
    executed: false,
    reason,
    ...(reason === "physical_call_ceiling" ? { message: researchWorkBudgetExhaustedText(session) } : {}),
  }));
}

function appendOwnerResearchSynthesisNotice(result, session, toolName, admission) {
  if (!admission?.physicalBatchId) result = preserveOwnerModelControlNotices(result, appendResearchWorkBudget(result, admission));
  result = appendResearchBudgetExhaustedNotice(result, admission, session);
  if (result?.isError === true || !admission?.tracked) return result;
  const guidanceEnabled = resolveAtlasResearchRuntimeGuidance();
  const explorationSteps = admission.explorationUnitWeight === 0
    ? admission.explorationSteps
    : (admission.assignedExplorationStep ?? admission.explorationSteps + 1);
  const callSteps = admission.assignedPhysicalCallStep
    ?? admission.callSteps + 1;
  const maxPhysicalCalls = admissionMaxPhysicalCalls(admission);
  const remainingPhysicalCalls = Math.max(0, maxPhysicalCalls - callSteps);
  if (admission.citationFetch && callSteps < maxPhysicalCalls && remainingPhysicalCalls > 3) return result;
  const curtainStart = RESEARCH_SYNTHESIS_MAX_EXPLORATION_STEPS
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS;
  const physicalCurtainStart = maxPhysicalCalls
    - RESEARCH_SYNTHESIS_CURTAIN_CALL_REMAINING_STEPS;
  const flags = researchNoticeFlagsFor(session);
  const explorationCeiling = researchSynthesisExplorationCeiling({
    staleSteps: admission.staleSteps,
  });
  let notice = null;
  let noticeKind = null;
  if (explorationSteps >= explorationCeiling || callSteps >= maxPhysicalCalls) {
    const physicalCeilingReached = callSteps >= maxPhysicalCalls;
    flags.midpoint = true;
    flags.curtain = true;
    recordOwnerResearchSynthesisRequired(session, {
      explorationSteps,
      callSteps,
      staleSteps: admission.staleSteps,
      lastNovelEvidenceStep: admission.lastNovelEvidenceStep,
      synthesisReason: physicalCeilingReached
        ? "physical_call_ceiling"
        : (admission.synthesisReason || "exploration_ceiling"),
      symbolFollowupsDiscounted: admission.symbolFollowupsDiscounted
        + (admission.symbolFollowupDiscounted ? 1 : 0),
    }, toolName);
    if (guidanceEnabled) {
      notice = buildResearchSynthesisRequiredText({
        explorationSteps,
        absoluteCeilingReached: true,
        explorationCeiling,
        finalTraversalAvailable: !physicalCeilingReached,
        handoffToolName: agentHandoffCallableName(session),
      });
      noticeKind = "research_closeout";
    }
  } else if (guidanceEnabled
    && (explorationSteps >= curtainStart || callSteps >= physicalCurtainStart)
    && !flags.curtain) {
    flags.midpoint = true;
    flags.curtain = true;
    const boot = session?.bootConfig || {};
    const completion = getTraversalCompletionSnapshotForCall({
      jobId: boot.jobId ?? null,
      attemptId: boot.attemptId ?? null,
    });
    notice = buildResearchCurtainCallText({
      explorationSteps,
      callSteps,
      maxPhysicalCalls,
      requirements: completion?.active === true ? completion.requirements : [],
      handoffToolName: agentHandoffCallableName(session),
    });
    noticeKind = "research_curtain";
  }
  let controlled = result;
  if (notice) {
    controlled = appendOwnerModelControlNotice(controlled, `\n\n${notice}`, {
      kind: noticeKind,
      trigger: noticeKind,
      explorationStep: explorationSteps,
    });
  }
  const finalSlotNotice = guidanceEnabled && callSteps < maxPhysicalCalls && remainingPhysicalCalls <= 3
    ? buildResearchFinalSlotLimitText({
      remainingCalls: remainingPhysicalCalls,
      handoffToolName: agentHandoffCallableName(session),
    })
    : "";
  if (finalSlotNotice && noticeKind !== "research_closeout") {
    controlled = appendOwnerModelControlNotice(controlled, `\n\n${finalSlotNotice}`, {
      kind: "research_final_slot_limit",
      trigger: "research_final_slot_limit",
      explorationStep: explorationSteps,
    });
  }
  return controlled;
}

export function __testAppendOwnerResearchSynthesisNotice(
  result,
  session,
  toolName,
  admission,
  toolArgs = {},
) {
  return appendOwnerResearchSynthesisNotice(result, session, toolName, admission, toolArgs);
}

/**
 * @param {{
 *   session?: any,
 *   message?: any,
 *   toolName?: string,
 *   toolArgs?: any,
 *   assignedPhysicalCallStep?: number,
 * }} [options]
 */
function ownerResearchPhysicalBudgetRejection({
  session,
  message,
  toolName,
  toolArgs,
  assignedPhysicalCallStep,
} = {}) {
  const boot = session?.bootConfig || {};
  const policy = researchSynthesisPolicyFor(session);
  const observed = researchExplorationObservationStatus({
    jobId: boot.jobId ?? null,
    attemptId: boot.attemptId ?? null,
    agentCallId: boot.agentCallId ?? null,
  });
  const requested = requestedToolPolicyName(toolName, toolArgs);
  const effectiveAction = requested.suite === "atlas"
    ? effectiveAtlasResearchAction(requested)
    : requested.name;
  const admission = {
    tracked: true,
    blocked: true,
    blockReason: "physical_call_ceiling",
    maxPhysicalCalls: policy.maxPhysicalCalls,
    explorationSteps: Math.max(0, Number(observed.exploration_steps || 0)),
    callSteps: Math.min(
      policy.maxPhysicalCalls,
      Math.max(0, Number(observed.call_steps || 0), Number(assignedPhysicalCallStep || 0) - 1),
    ),
    staleSteps: Math.max(0, Number(observed.stale_steps || 0)),
    assignedPhysicalCallStep,
    citationFetch: requested.suite === "atlas" && isResearchAtlasCitationFetchAction(effectiveAction),
  };
  if (boot.attemptId != null) {
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId,
      observation_type: "research.exploration_blocked",
      summary: "Research work blocked: physical_call_ceiling",
      detail: {
        action: effectiveAction,
        tool: `${requested.suite}.${requested.name}`,
        physical_request: 1,
        executed: false,
        consumed_step: false,
        attempted_physical_call_step: assignedPhysicalCallStep,
        call_steps: admission.callSteps,
        physical_call_ceiling: policy.maxPhysicalCalls,
        reason: "physical_call_ceiling",
        mcp_request_id: message?.id ?? null,
      },
    });
  }
  const guidanceEnabled = resolveAtlasResearchRuntimeGuidance();
  const gateText = buildResearchSynthesisRequiredText({
    explorationSteps: admission.explorationSteps,
    staleSteps: admission.staleSteps,
    absoluteCeilingReached: true,
    finalTraversalAvailable: false,
    handoffToolName: agentHandoffCallableName(session),
  });
  let result = guidanceEnabled
    ? tagOwnerModelControlNotice({
        content: [{ type: "text", text: gateText }],
        isError: false,
      }, gateText, {
        kind: "research_closeout_gate",
        trigger: "physical_call_ceiling",
        physicalCallStep: assignedPhysicalCallStep,
      })
    : unguidedResearchBlockedPayload("physical_call_ceiling", session);
  result = preserveOwnerModelControlNotices(result, appendResearchWorkBudget(result, admission));
  recordOwnerToolObservation({
    session,
    toolName,
    toolArgs,
    result,
    outcomeOverride: "rejected",
    synthesisAdmission: admission,
    executor: { via: "research_physical_call_gate" },
    observationDetail: {
      executed: false,
      consumed_step: false,
      budget_rejected: true,
      rejection_reason: "physical_call_ceiling",
      attempted_physical_call_step: assignedPhysicalCallStep,
    },
  });
  return mcpToolResultMessage(message, result);
}

// A live write refresh rebuilds the WI view through the conductor with only
// the session's boot config. Sessions whose boot config predates the view-mode
// fields rebuilt the view without layer-merge symbols, and every later
// prefetch rejected it (WI 138 job 1779, WI 149 job 1931, 2026-10-01).
export function atlasWriteRefreshViewMode(session) {
  const atlas = session?.bootConfig?.atlas;
  if (typeof atlas?.viewLayerMerge === "boolean") return {};
  try {
    const config = getAtlasIntegrationConfig();
    return {
      viewLayerMerge: config?.viewLayerMerge === true,
      ...(config?.treeCompressionMode ? { treeCompressionMode: config.treeCompressionMode } : {}),
      ...(config?.treeCompressionMaxSeeds != null ? { treeCompressionMaxSeeds: config.treeCompressionMaxSeeds } : {}),
    };
  } catch {
    return {};
  }
}

function atlasExecutorSessionContext(session, bootConfig = session?.bootConfig || {}) {
  return {
    id: session?.id || null,
    bootConfig: stripGatewaySessionTokenFields(bootConfig),
    tokenSource: session?.tokenSource || null,
    tokenVerified: session?.tokenVerified === true,
  };
}

function isAtlasFetchRefTool(toolName, toolArgs) {
  const requested = requestedToolPolicyName(toolName, toolArgs);
  return requested.suite === "atlas" && ["traverse_ref", "fetch_ref"].includes(requested.name);
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
  const structureCompacted = compactCodeStructureResult(requested.name || toolName, first.text, {
    args,
    context,
    projection: researcherStructureProjection(session),
    maxChars: structureMaxChars(session),
  });
  const compacted = structureCompacted.compacted
    ? structureCompacted
    : compactCodeSurveyResult(requested.name || toolName, first.text, { args, context });
  const refPaged = compacted.compacted
    ? compacted
    : compactCodeWindowLensResult(requested.name || toolName, compacted.result, { args, context });
  const stamped = appendHashRefIfMajor(requested.name || toolName, refPaged.result, {
    meterAtDelivery: true,
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
    kind: structureCompacted.compacted
      ? "code_structure_compaction"
      : (compacted.compacted
        ? "code_survey_compaction"
        : (refPaged.compacted ? "code_window_lens_compaction" : "hash_ref_surface")),
    action: requested.name || toolName,
    ...(structureCompacted.compacted ? {
      projection: structureCompacted.projection,
      pages: structureCompacted.pages,
      rows: structureCompacted.rows,
      ...(structureCompacted.continuationUnavailable ? { continuation_unavailable: true } : {}),
    } : {}),
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

export function __testJsonlParseBuffer(buffer, onMessage, opts = {}) {
  return jsonlParseBuffer(buffer, onMessage, opts);
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
    const notification = gatewaySessionReleaseNotification(session);
    const releasedExecution = this._gatewaySession?.notify?.(notification) === true;
    const releasedControl = this._gatewaySession?._controlSession?.notify?.(notification) === true;
    return releasedExecution || releasedControl;
  }

  _removeSession(id, { reason = "released", context = null, telemetry = true } = {}) {
    const session = id ? this._sessions.get(id) : null;
    if (!session) return { released: false, reason: "not_found", sessionCount: this._sessions.size };
    const attachProof = session.snapshotAttachProof();
    this._sessions.delete(id);
    this._sessionIdsByTokenHash.delete(tokenHash(session.token));
    // The file this session edited last waits for the agent to move on; the
    // session ending is the last such signal.
    void flushSharedAtlasToolExecutorDeferredRefreshes({ sessionId: id });
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
    // Count the final delivered payload once, including native gateway reads,
    // dispatch results and every source block, rather than hash-ref fragments.
    const sendResponse = (response, status, body) => {
      sendJson(response, status, body);
      try {
        ContextMeter.forContext(hashRefToolContext(session))?.recordMcpResponse(message.method, body?.message?.result);
      } catch { /* Shadow telemetry must never affect tool delivery. */ }
    };
    const requestAbort = new AbortController();
    let heartbeat = null;
    if (req.headers[MCP_OWNER_PROGRESS_HEADER] === "1") {
      res.writeProcessing();
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.writeProcessing();
      }, MCP_OWNER_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
    }
    res.once("close", () => {
      if (heartbeat) clearInterval(heartbeat);
      if (!res.writableFinished) requestAbort.abort(new Error("MCP client disconnected"));
    });
    const method = String(message?.method || "").trim();
    if (method === MCP_SESSION_RELEASED_NOTIFICATION) {
      sendResponse(res, 403, { ok: false, error: "reserved_owner_method" });
      return;
    }
    const activeToolRequest = method === "tools/call"
      ? session.beginToolRequest(message?.params?.name)
      : null;
    // Set once a research physical call is tracked against the ceiling
    // emission; released in the finally below so a thrown handler still
    // closes the emission accounting.
    let releaseResearchCeilingEmission = null;
    const preflight = body?.preflight === true && method === "tools/list";
    const proofEvent = preflight ? null : session.noteRequest(message);
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
        let accepted = !!record && ["staged", "committed"].includes(record.status);
        if (accepted) {
          agentHandoffTerminator.acknowledge(agentCallId, {
            source: "mcp_receipt",
            role: session?.bootConfig?.role || null,
            sessionId: id,
            digest: record.packet_digest || null,
          });
        } else {
          accepted = acknowledgeWebResearchHandoffReceipt(agentCallId, {
            source: "mcp_receipt",
            role: session?.bootConfig?.role || null,
            sessionId: id,
          });
        }
        sendResponse(res, 200, {
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
      let assignedResearchPhysicalCallStep = null;
      let researchPhysicalCeilingGrace = false;
      if (message.method === "tools/call") {
        const providerToolName = String(message?.params?.name || "");
        const rawProviderToolArgs = message?.params?.arguments || {};
        if (delegatedEvidence) {
          if (!delegatedEvidenceRequestAllowed(providerToolName, rawProviderToolArgs)) {
            sendResponse(res, 200, { ok: true, message: {
              jsonrpc: "2.0", id: message.id,
              result: mcpToolErrorPayload("Citation children may only consume issued read-only evidence tools"),
            } });
            return;
          }
        }
        const providerToolArgs = rawProviderToolArgs;
        const managedRequest = requestedToolPolicyName(providerToolName, providerToolArgs);
        if (!teamManagedToolAdmitted(managedRequest.suite, managedRequest.name, {
          transport: "persistent-mcp",
          workItemId: session?.bootConfig?.workItemId,
        })) {
          sendResponse(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: mcpToolResultMessage(message, mcpToolErrorPayload(
              "Team approval mode does not permit this tool route",
              { code: "team_tool_route_blocked" },
            )),
          });
          return;
        }
        if (!toolAllowedByPolicy(policy, providerToolName, providerToolArgs)) {
          recordDeniedToolCall(session, providerToolName, providerToolArgs, policy, message);
          sendResponse(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: deniedToolCallMessage(message, providerToolName, policy, providerToolArgs),
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
        const callId = session?.bootConfig?.agentCallId;
        if (finalReviewPassedForCall(callId)) {
          sendResponse(res, 200, { ok: true, bootId: this.bootId, sessionId: id,
            message: mcpToolResultMessage(message, mcpToolErrorPayload(
              "Final review passed; this agent call is complete and cannot run more tools.",
            )) });
          return;
        }
        if (finalReviewRuntime.parents.get(Number(callId))?.inFlight) {
          sendResponse(res, 200, { ok: true, bootId: this.bootId, sessionId: id,
            message: mcpToolResultMessage(message, mcpToolErrorPayload(
              "Final review is running; wait for its result before calling another tool.",
            )) });
          return;
        }
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
          sendResponse(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: mcpToolResultMessage(message, result),
          });
          return;
        }
        const requested = requestedToolPolicyName(toolName, toolArgs);
        const plannerReadRejection = reservePlannerRead(session, policy, requested);
        if (plannerReadRejection) {
          recordOwnerToolObservation({ session, toolName, toolArgs, result: plannerReadRejection,
            durationMs: 0, observationDetail: { planner_read_budget_exhausted: true } });
          sendResponse(res, 200, { ok: true, bootId: this.bootId, sessionId: id,
            message: mcpToolResultMessage(message, plannerReadRejection) });
          return;
        }
        assignedResearchPhysicalCallStep = isResearchPhysicalWorkRequest(requested)
          ? this._reserveResearchPhysicalCall(session, requested)
          : null;
        const researchPhysicalCallCeiling = researchSynthesisPolicyFor(session).maxPhysicalCalls;
        const ceilingEmission = Number.isSafeInteger(assignedResearchPhysicalCallStep)
          ? researchCeilingEmissionFor(session)
          : null;
        if (ceilingEmission && assignedResearchPhysicalCallStep >= researchPhysicalCallCeiling) {
          ceilingEmission.opened = true;
        }
        if (ceilingEmission && assignedResearchPhysicalCallStep > researchPhysicalCallCeiling) {
          const grace = researchCeilingGraceDecision(ceilingEmission);
          if (!grace.grace) {
            sendResponse(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: ownerResearchPhysicalBudgetRejection({
                session,
                message,
                toolName,
                toolArgs,
                assignedPhysicalCallStep: assignedResearchPhysicalCallStep,
              }),
            });
            return;
          }
          researchPhysicalCeilingGrace = true;
          if (session?.bootConfig?.attemptId != null) {
            recordObservation({
              work_item_id: session.bootConfig.workItemId ?? null,
              job_id: session.bootConfig.jobId ?? null,
              attempt_id: session.bootConfig.attemptId,
              observation_type: "research.ceiling_grace",
              summary: `Research call ${assignedResearchPhysicalCallStep} admitted past the ${researchPhysicalCallCeiling}-call ceiling: ${grace.reason}`,
              detail: {
                tool: `${requested.suite}.${requested.name}`,
                physical_call_step: assignedResearchPhysicalCallStep,
                physical_call_ceiling: researchPhysicalCallCeiling,
                reason: grace.reason,
                emission_active: ceilingEmission.active,
                mcp_request_id: message?.id ?? null,
              },
            });
          }
        }
        if (ceilingEmission) {
          ceilingEmission.active += 1;
          releaseResearchCeilingEmission = () => {
            releaseResearchCeilingEmission = null;
            ceilingEmission.active = Math.max(0, ceilingEmission.active - 1);
            ceilingEmission.lastReleasedAt = Date.now();
          };
        }
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
            recordOwnerAssessorBudgetExhaustion({
              session,
              toolName,
              toolArgs,
              reason: ceiling.reason,
              text: ceiling.text,
              used: ceiling.used,
              cap: ceiling.cap,
            });
            sendResponse(res, 200, {
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
            // The read allowance is advisory: the read proceeds past it and
            // the gateway records the advisory. Withholding the read pushed
            // assessors into needs_review verdicts they did not mean.
            session._assessorFallbackReadCount = Number(session._assessorFallbackReadCount || 0) + 1;
            void fallbackReadCap;
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
          sendResponse(res, 200, {
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
          const conflicts = session.toolRequestConflicts(activeToolRequest);
          if (conflicts.length > 0) {
            const result = mcpToolErrorPayload(
              "agent_handoff cannot be submitted while sibling tool calls are still running; wait for their results and submit a new terminal report",
              { code: "terminal_handoff_concurrent_tool", details: { conflicts } },
            );
            recordOwnerAnsweredToolCall({
              session,
              toolName,
              toolArgs,
              result,
              via: "agent_handoff_owner",
              rejectionCode: "terminal_handoff_concurrent_tool",
            });
            sendResponse(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: mcpToolResultMessage(message, result),
            });
            return;
          }
          try {
            assertSubAgentParentReady(session?.bootConfig?.agentCallId);
            preparedSubAgentHandoff = prepareSubAgentHandoff(
              session?.bootConfig?.agentCallId,
              toolArgs,
            );
          } catch (error) {
            recordAgentHandoffRejection(session?.bootConfig?.agentCallId, error);
            const result = {
              content: [{ type: "text", text: `Error executing agent_handoff: ${String(error?.message || error).slice(0, 500)}` }],
              isError: true,
            };
            recordOwnerAnsweredToolCall({
              session,
              toolName,
              toolArgs,
              result,
              via: "agent_handoff_owner",
              rejectionCode: String(error?.code || "AGENT_HANDOFF_REJECTED"),
            });
            sendResponse(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result,
              },
            });
            return;
          }
        }
        if (requested.name !== "agent_handoff"
          && rejectAgentHandoffForLaterTool(session?.bootConfig?.agentCallId, requested.name || toolName)) {
          const result = {
            content: [{
              type: "text",
              text: "agent_handoff was already staged; later tool calls invalidate the terminal report",
            }],
            isError: true,
          };
          recordOwnerAnsweredToolCall({
            session,
            toolName,
            toolArgs,
            result,
            via: "agent_handoff_owner",
            rejectionCode: "agent_handoff_terminal_violation",
          });
          sendResponse(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: {
              jsonrpc: "2.0",
              id: message?.id ?? null,
              result,
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
            sendResponse(res, 200, {
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
            sendResponse(res, 200, {
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
        if (requested.suite === "tools" && requested.name === "custom_tools") {
          // The shared hot gateway never holds agent tokens. The automation
          // owner authorizes Custom Tools from this session's signed token.
          const startedAt = Date.now();
          let result;
          try {
            const payload = await new AutomationOwnerClient({
              token: session.token,
              timeoutMs: CUSTOM_TOOLS_AGENT_REQUEST_TIMEOUT_MS,
            }).request("tool", toolArgs);
            result = { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
          } catch (error) {
            result = { content: [{ type: "text", text: `Error executing custom_tools: ${String(error?.message || error).slice(0, 500)}` }], isError: true };
          }
          recordOwnerAnsweredToolCall({ session, toolName, toolArgs, result, startedAt, via: "custom_tools_owner" });
          sendResponse(res, 200, { ok: true, bootId: this.bootId, sessionId: id, message: {
            jsonrpc: "2.0", id: message?.id ?? null, result,
          } });
          return;
        }
        if (requested.suite === "tools" && requested.name === "web_research_handoff") {
          const startedAt = Date.now();
          try {
            const receipt = submitWebResearchHandoff(session?.bootConfig?.agentCallId, toolArgs);
            const result = { content: [{ type: "text", text: JSON.stringify(receipt) }], isError: false };
            recordOwnerAnsweredToolCall({ session, toolName, toolArgs, result, startedAt, via: "web_research_handoff_owner" });
            sendResponse(res, 200, { ok: true, bootId: this.bootId, sessionId: id, terminalHandoffReceipt: true, message: {
              jsonrpc: "2.0", id: message?.id ?? null, result,
            } });
          } catch (error) {
            const result = { content: [{ type: "text", text: String(error?.message || error) }], isError: true };
            recordOwnerAnsweredToolCall({ session, toolName, toolArgs, result, startedAt, via: "web_research_handoff_owner" });
            sendResponse(res, 200, { ok: true, bootId: this.bootId, sessionId: id, message: {
              jsonrpc: "2.0", id: message?.id ?? null, result,
            } });
          }
          return;
        }
        if (requested.suite === "tools" && requested.name === "final_review") {
          if (session.toolRequestConflicts(activeToolRequest).length > 0) {
            sendResponse(res, 200, { ok: true, bootId: this.bootId, sessionId: id,
              message: mcpToolResultMessage(message, mcpToolErrorPayload(
                "Final review cannot start while sibling tool calls are running; wait for their results.",
              )) });
            return;
          }
          // Runs the declared tests and a reviewer child of this agent call;
          // the owner's progress heartbeat holds the transport open meanwhile.
          const startedAt = Date.now();
          const boot = session.bootConfig;
          const invocation = beginToolInvocation({ tool: toolName, input: toolArgs, cwd: boot.cwd,
            work_item_id: boot.workItemId, job_id: boot.jobId, attempt_id: boot.attemptId, agent_call_id: boot.agentCallId });
          let text;
          let isError = false;
          let reviewResult = null;
          try {
            const result = await executeFinalReview(toolArgs, {
              context: { agentCallId: session?.bootConfig?.agentCallId },
              signal: requestAbort.signal,
            });
            reviewResult = { status: result.status, outcome: result.outcome, reason: result.reason,
              summary: result.summary, error: result.error, findings: result.findings };
            if (result?.status === FINAL_REVIEW_REVIEWER_STATUS.REVISED) {
              // Each bounce is a new review: the waiting reviewer gets a fresh
              // tool and read allowance instead of "budget exhausted" advisories.
              session._assessorToolCallCount = 0;
              session._assessorFallbackReadCount = 0;
            }
            text = JSON.stringify(result);
          } catch (error) {
            isError = true;
            text = `Error executing final_review: ${String(error?.message || error).slice(0, 500)}`;
          }
          const result = { content: [{ type: "text", text }], isError };
          recordOwnerAnsweredToolCall({ session, toolName, toolArgs, result, startedAt, via: "final_review_owner",
            observationDetail: { ...(invocation ? { inv: invocation.inv } : {}), phase: "finish",
              final_review_result: reviewResult } });
          sendResponse(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: {
              jsonrpc: "2.0",
              id: message?.id ?? null,
              result,
            },
          });
          return;
        }
        if (requested.suite === "tools" && ["sub_agent", "dispatch_agent"].includes(requested.name)) {
          const startedAt = Date.now();
          try {
            const execute = requested.name === "dispatch_agent" ? executeDispatchAgent : executeSubAgent;
            const result = await execute(toolArgs, {
              context: {
                workItemId: session?.bootConfig?.workItemId,
                jobId: session?.bootConfig?.jobId,
                attemptId: session?.bootConfig?.attemptId,
                agentCallId: session?.bootConfig?.agentCallId,
              },
              // Only a dispatch still waiting for lane capacity stops when the
              // client goes away; admitted children keep their own lifecycle.
              admissionSignal: requestAbort.signal,
            });
            recordObservation({
              work_item_id: session?.bootConfig?.workItemId ?? null,
              job_id: session?.bootConfig?.jobId ?? null,
              attempt_id: session?.bootConfig?.attemptId ?? null,
              observation_type: `tool.${requested.name}`,
              summary: `${requested.name} ${toolArgs?.agent_type || toolArgs?.op || "operation"} completed`,
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
            if (Array.isArray(result?.repairs) && result.repairs.length > 0) {
              // Repaired arguments are accepted, not rejected; record them
              // beside the error lane so argument drift stays visible.
              recordObservation({
                work_item_id: session?.bootConfig?.workItemId ?? null,
                job_id: session?.bootConfig?.jobId ?? null,
                attempt_id: session?.bootConfig?.attemptId ?? null,
                observation_type: `tool.${requested.name}.repaired`,
                summary: `${requested.name} accepted ${result.repairs.length} repaired argument(s)`,
                detail: {
                  repairs: result.repairs.slice(0, 24),
                  batch_id: result?.batch_id || null,
                  parent_agent_call_id: session?.bootConfig?.agentCallId ?? null,
                },
              });
            }
            noteSubAgentRoutingSuccess(
              routingState,
              requested,
              toolArgs,
              result,
              subAgentRoutingContext(session),
            );
            // This path answers directly, so a completed dispatch ends the
            // planner's triage count here rather than in the notice hook.
            if (requested.name === "dispatch_agent") notePlannerTriageCall(session, policy, requested);
            sendResponse(res, 200, {
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
              observation_type: `tool.${requested.name}.error`,
              summary: `Sub-agent ${toolArgs?.op || "operation"} rejected (${errorCode})`,
              detail: {
                op: toolArgs?.op || null,
                code: errorCode,
                // Without the message and the argument shape a rejection cannot
                // be diagnosed afterwards; key names only, never their content.
                message: String(error?.message || "").slice(0, 300),
                arg_keys: toolArgs && typeof toolArgs === "object" ? Object.keys(toolArgs).slice(0, 12) : [],
                request_count: Array.isArray(toolArgs?.requests) ? toolArgs.requests.length : null,
                stage: String(error?.stage || "runtime").slice(0, 40),
                retryable: error?.retryable === true,
                ...(errorCode === "SUB_AGENT_INPUT_TOOL_FORBIDDEN" && error?.inputTool
                  ? { input_tool: String(error.inputTool).slice(0, 160) }
                  : {}),
                // A child that ran before the dispatch failed has its own row.
                ...(Number.isSafeInteger(Number(error?.agentCallId)) && Number(error.agentCallId) > 0
                  ? { child_agent_call_id: Number(error.agentCallId) }
                  : {}),
                parent_agent_call_id: session?.bootConfig?.agentCallId ?? null,
                duration_ms: Date.now() - startedAt,
              },
            });
            sendResponse(res, 200, {
              ok: true,
              bootId: this.bootId,
              sessionId: id,
              message: {
                jsonrpc: "2.0",
                id: message?.id ?? null,
                result: {
                  content: [{ type: "text", text: `Error executing ${requested.name}: ${String(error?.message || error).slice(0, 500)}` }],
                  isError: true,
                },
              },
            });
          }
          return;
        }
        if (requested.suite === "atlas") {
          const response = await this._executeAtlasToolCall({
            message,
            session,
            toolName,
            toolArgs,
            providerTransforms: routedTool.transforms,
            delegatedEvidence,
            assignedPhysicalCallStep: assignedResearchPhysicalCallStep,
            physicalCeilingGrace: researchPhysicalCeilingGrace,
          });
          if (rejectAgentHandoffForLaterTool(
            session?.bootConfig?.agentCallId,
            requested.name || toolName,
          )) {
            sendResponse(res, 200, {
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
          const routedResponse = appendToolResultText(response, reminder, {
            kind: "sub_agent_routing_checkpoint",
            trigger: "parent_evidence_threshold",
          });
          if (routedResponse !== response) {
            recordOwnerModelControlNotice(session, requested.name || toolName, {
              kind: "sub_agent_routing_checkpoint",
              text: reminder,
              trigger: "parent_evidence_threshold",
            });
          }
          // Delegated evidence feeds a child's input, not this model.
          const finalizedResponse = delegatedEvidence
            ? routedResponse
            : appendCodexSoftCheckpoint(
                appendPlannerTriageNotice(routedResponse, session, policy, requested, requested.name || toolName),
                session,
                requested.name || toolName,
              );
          sendResponse(res, 200, {
            ok: true,
            bootId: this.bootId,
            sessionId: id,
            message: finalizedResponse,
          });
          return;
        }
      }
      const gatewayAdmission = {
        tracked: Number.isSafeInteger(assignedResearchPhysicalCallStep),
        assignedPhysicalCallStep: assignedResearchPhysicalCallStep,
        physicalCeilingGrace: researchPhysicalCeilingGrace,
      };
      let response;
      try {
        const outbound = injectSessionContext(message, session, { delegatedEvidence });
        response = MCP_CONTROL_METHODS.includes(message.method)
          ? await this._gatewaySession.requestControl(outbound, { signal: requestAbort.signal })
          : await this._gatewaySession.request(outbound, { signal: requestAbort.signal });
      } catch (error) {
        this._refundResearchInfrastructureFailure(session, gatewayAdmission, null, {
          code: "native_transport_error", message: String(error?.message || error),
        });
        throw error;
      }
      this._refundResearchInfrastructureFailure(session, gatewayAdmission, response?.result);
      if (gatewayAdmission.tracked && response?.result) {
        response = { ...response, result: preserveOwnerModelControlNotices(response.result,
          appendResearchWorkBudget(response.result, {
            ...gatewayAdmission,
            maxPhysicalCalls: researchSynthesisPolicyFor(session).maxPhysicalCalls,
            reservedPhysicalCalls: () => this._researchCallReservations.get(researchBudgetKey(session.bootConfig)),
          })) };
      }
      if (message.method === "tools/call") {
        const requested = requestedToolPolicyName(
          String(message?.params?.name || ""),
          message?.params?.arguments || {},
        );
        if (requested.suite === "tools"
          && requested.name === "agent_handoff"
          && mcpToolCallSuccess(response)) {
          const conflicts = session.toolRequestConflicts(activeToolRequest);
          if (conflicts.length > 0) {
            rejectAgentHandoffForLaterTool(
              session?.bootConfig?.agentCallId,
              conflicts[0] || "concurrent_tool",
            );
            response = mcpToolResultMessage(message, mcpToolErrorPayload(
              "agent_handoff overlapped a sibling tool call; the terminal report was invalidated so those results can be considered",
              { code: "terminal_handoff_concurrent_tool", details: { conflicts } },
            ));
          }
        }
        // A native read delivers exact source too. Record what it showed in the
        // same coverage ledger the Atlas reads use, so a later Atlas read over
        // those lines is recognised as already delivered.
        if (requested.suite === "tools" && mcpToolCallSuccess(response)
          && ["read_file", "search_files"].includes(requested.name)) {
          const repeated = await this._recordNativeReadCoverage(
            session,
            message?.params?.arguments || {},
            response.result,
            requested.name,
          );
          if (repeated) {
            response = {
              ...response,
              result: appendOwnerModelControlNotice(response.result, `\n\n${repeated}`, {
                kind: "native_read_repeated_source",
                trigger: requested.name,
              }),
            };
          }
        }
        const physicalCallCeiling = researchSynthesisPolicyFor(session).maxPhysicalCalls;
        if (gatewayAdmission.tracked && response?.result && !resolveAtlasResearchRuntimeGuidance()) {
          const priorResult = response.result;
          const result = appendAndRecordResearchBudgetNotice(priorResult, {
            ...gatewayAdmission,
            maxPhysicalCalls: physicalCallCeiling,
            reservedPhysicalCalls: () => this._researchCallReservations.get(researchBudgetKey(session.bootConfig)),
          }, session, requested.name);
          if (result !== priorResult) response = { ...response, result };
        }
        if (mcpToolCallSuccess(response)
          && Number.isSafeInteger(assignedResearchPhysicalCallStep)
          && assignedResearchPhysicalCallStep >= physicalCallCeiling) {
          const observed = researchExplorationObservationStatus({
            jobId: session?.bootConfig?.jobId ?? null,
            attemptId: session?.bootConfig?.attemptId ?? null,
            agentCallId: session?.bootConfig?.agentCallId ?? null,
          });
          if (observed.synthesis_required !== true) {
            recordOwnerResearchSynthesisRequired(session, {
              explorationSteps: observed.exploration_steps,
              callSteps: physicalCallCeiling,
              staleSteps: observed.stale_steps,
              lastNovelEvidenceStep: observed.last_novel_evidence_step,
              synthesisReason: "physical_call_ceiling",
              symbolFollowupsDiscounted: observed.symbol_followups_discounted,
            }, requested.name || String(message?.params?.name || ""));
          }
          const notice = buildResearchSynthesisRequiredText({
            explorationSteps: observed.exploration_steps,
            staleSteps: observed.stale_steps,
            absoluteCeilingReached: true,
            finalTraversalAvailable: false,
            handoffToolName: agentHandoffCallableName(session),
          });
          // Unguided sessions received the factual exhaustion notice above.
          if (resolveAtlasResearchRuntimeGuidance()
            && !JSON.stringify(response?.result?.content || []).includes("physical work-call ceiling is reached")) {
            const priorResponse = response;
            response = appendToolResultText(priorResponse, `\n\n${notice}`, {
              kind: "research_closeout",
              trigger: "physical_call_ceiling",
            });
            if (response !== priorResponse) {
              recordOwnerModelControlNotice(session, requested.name, {
                kind: "research_closeout",
                text: notice,
                trigger: "physical_call_ceiling",
              });
            }
          }
        }
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
        if (!delegatedEvidence) {
          response = appendPlannerTriageNotice(response, session, policy, requested, requested.name);
        }
      }
      if (message.method === "tools/call" && mcpToolCallSuccess(response)) {
        const writtenTool = requestedToolPolicyName(
          String(message?.params?.name || ""),
          message?.params?.arguments || {},
        );
        // A terminal handoff receipt ends the call: it neither carries the
        // checkpoint nor spends it. Delegated evidence feeds a child's input.
        if (!delegatedEvidence
          && !(writtenTool.suite === "tools" && MCP_TERMINAL_HANDOFF_TOOLS.includes(writtenTool.name))) {
          response = appendCodexSoftCheckpoint(response, session, String(message?.params?.name || ""));
        }
        // A successful write keeps the runtime watchdog from killing a job
        // that is still producing its change (bounded by a hard ceiling).
        if (writtenTool.suite === "tools") {
          jobWriteActivity.noteToolCall(session?.bootConfig?.jobId, writtenTool.name);
        }
        const refreshTelemetryContext = attachTelemetryContext(session, this.bootId);
        void this._scheduleAtlasWriteRefresh({ message, session, response, telemetryContext: refreshTelemetryContext }).catch((err) => {
          appendRunTelemetry("diagnostics", {
            kind: "mcp.owner.atlas_write_refresh",
            ...refreshTelemetryContext,
            outcome: "error",
            duration_ms: 0,
            error: ownerErrorSummary(err),
          });
        });
      }
      if (message.method === "tools/list") {
        response = filterToolsListMessage(response, policy);
        recordProviderIssuedToolSurface(session, response, researchSynthesisPolicyFor);
        const count = preflight ? toolsListCount(response) : session.noteToolsList(response);
        const listError = toolsListError(response);
        if (!preflight) {
        this._logAttachProof(session, "mcp.attach.tools_list_seen", {
          method,
          tool_count: count,
          tool_names: session.attachProof.toolsListNames,
          tool_names_sha256: session.attachProof.toolsListSha256,
          agent_handoff_schema_name: session.attachProof.agentHandoffToolSchemaName,
          agent_handoff_schema_sha256: session.attachProof.agentHandoffToolSchemaSha256,
          agent_handoff_schema_chars: session.attachProof.agentHandoffToolSchemaChars,
          request_count: session.attachProof.requestCount,
          ...(listError ? { error: listError } : {}),
        });
        }
        if (listError) recordToolsListFailure(session, listError);
      }
      const completedTool = message.method === "tools/call"
        ? requestedToolPolicyName(
            String(message?.params?.name || ""),
            message?.params?.arguments || {},
          )
        : null;
      const terminalHandoffReceipt = completedTool?.suite === "tools"
        && MCP_TERMINAL_HANDOFF_TOOLS.includes(completedTool.name)
        && mcpToolCallSuccess(response);
      // Handing off is the agent moving on from the file it edited last:
      // refresh it now so the assessor's ATLAS reads start from a current view.
      if (terminalHandoffReceipt && completedTool.name === "agent_handoff") {
        void flushSharedAtlasToolExecutorDeferredRefreshes({ sessionId: session?.id || id });
      }
      sendResponse(res, 200, {
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
      sendResponse(res, 500, {
        ok: false,
        bootId: this.bootId,
        sessionId: id,
        error: String(err?.message || err),
      });
    } finally {
      if (activeToolRequest != null) session.endToolRequest(activeToolRequest);
      if (releaseResearchCeilingEmission) releaseResearchCeilingEmission();
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
    if (!["code.window", "symbol.get"].includes(effectiveAction) || !toolArgs?.symbolId || toolArgs?.file) return false;
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

  _reserveResearchPhysicalCall(session, requested) {
    const boot = session?.bootConfig || {};
    if (
      String(boot.role || "") !== "researcher"
      || !isResearchPhysicalWorkRequest(
        typeof requested === "string"
          ? { suite: "atlas", name: requested, nested: "" }
          : requested,
      )
    ) return null;
    const reservationKey = researchBudgetKey(boot);
    const observed = researchExplorationObservationStatus({
      jobId: boot.jobId ?? null,
      attemptId: boot.attemptId ?? null,
    agentCallId: boot.agentCallId ?? null,
    });
    const assigned = Math.max(
      Math.max(0, Number(observed.call_steps || 0)),
      Number(this._researchCallReservations.get(reservationKey) || 0),
    ) + 1;
    this._researchCallReservations.set(reservationKey, assigned);
    return assigned;
  }

  // Native reads are not Atlas admissions: they own no selector suppression and
  // no context-headroom reservation. Custody only records the delivered lines,
  // and SourceCoverageOwner verifies every byte against the current file, so a
  // stale, clipped, or non-source read simply records nothing.
  async _recordNativeReadCoverage(session, toolArgs, result, tool = "read_file") {
    const boot = session?.bootConfig || {};
    if (String(boot.role || "") !== "researcher" || !Number.isSafeInteger(Number(boot.attemptId))) return;
    const text = (Array.isArray(result?.content) ? result.content : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("\n");
    // Search rows carry their own file headers; a numbered read is one file.
    const hunks = tool === "search_files"
      ? searchResultCoverageHunks(text)
      : numberedReadCoverageHunks(text, { path: toolArgs?.path });
    if (hunks.length === 0) return null;
    const owner = sourceCoverageOwnerForSession(session, boot);
    // What this read re-delivers is worth stating, not withholding: a native
    // read is never refused, and the caller decides whether the context it
    // already holds is enough.
    let repeatedLines = 0;
    const repeatedRefs = new Set();
    for (const hunk of hunks) {
      try {
        const prior = owner.deliveredCoverageWithin(hunk.repo_rel_path, hunk.startLine, hunk.endLine);
        repeatedLines += prior.lines;
        for (const ref of prior.refs) repeatedRefs.add(ref);
      } catch { /* The note is advisory; accounting must never fail a read. */ }
    }
    const redactedSources = new Map();
    for (const hunk of hunks) {
      try {
        await owner.materializeDisplayedData(hunk, { file: hunk.repo_rel_path }, {
          origin: tool === "search_files" ? "native_search" : "native_read",
          tool, redactedSources, completeSymbolSelector: null,
          suppressive: sourceCoverageIsSuppressive(tool),
        });
      } catch { /* Custody is best-effort: a read must never fail on accounting. */ }
    }
    if (repeatedLines <= 0) return null;
    const refs = [...repeatedRefs];
    return `SOURCE ALREADY DELIVERED: ${repeatedLines} of these lines were delivered earlier in this attempt`
      + `${refs.length > 0 ? ` as ${refs.join(", ")}` : ""}.`;
  }

  _refundResearchInfrastructureFailure(session, admission, result, error = null) {
    if (admission?.physicalBatchId) return false;
    if (!admission?.tracked || admission.citationFetch) return false;
    const structuredError = ownerToolStructuredError(result, error);
    if (!isResearchInfrastructureFailure(structuredError)) return false;
    const boot = session?.bootConfig || {};
    const reservationKey = researchBudgetKey(boot);
    const observed = researchExplorationObservationStatus({
      jobId: boot.jobId ?? null,
      attemptId: boot.attemptId ?? null,
    agentCallId: boot.agentCallId ?? null,
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
    agentCallId: boot.agentCallId ?? null,
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

  async _executeAtlasToolCall(args) {
    return observeAtlasRequest(args, (request) => this._executeAtlasRequestItems(request));
  }

  async _executeAtlasRequestItems(args) {
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
    const effectiveToolArgs = args?.toolArgs?.args && typeof args.toolArgs.args === "object"
      ? args.toolArgs.args
      : args?.toolArgs;
    if (effectiveAction === "symbol.get" && isSymbolGetBatch(effectiveToolArgs)) {
      const plan = planSymbolGetBatch(effectiveToolArgs, {
        resolveSymbolId: value => resolveAtlasSymbolHandle(args.session, value),
        sourcePathForId: value => atlasSymbolSourcePath(args.session, value),
      });
      if (plan.error) return mcpToolResultMessage(args.message, mcpToolErrorPayload(plan.error, {
        code: "invalid_params", message: plan.error,
      }));
      const physicalStep = Number.isSafeInteger(args.assignedPhysicalCallStep)
        ? args.assignedPhysicalCallStep : this._reserveResearchPhysicalCall(args.session, requested);
      if (args.physicalRequest) args.physicalRequest.physicalStep ??= physicalStep;
      const physicalBatchId = crypto.randomUUID();
      const responses = await Promise.all(plan.items.map((item, index) => item.invalid
        ? { result: mcpToolErrorPayload(item.error || "Invalid symbol.get batch item", {
          code: "invalid_item", message: item.error || "Invalid symbol.get batch item",
        }) }
        : this._executeAtlasToolCall({ ...args, binding, toolName: "atlas.symbol.get", toolArgs: item,
          assignedPhysicalCallStep: physicalStep,
          physicalCeilingGrace: args.physicalCeilingGrace === true,
          sameStepRecovery: args.sameStepRecovery === true,
          physicalBatchId,
          message: { ...args.message, id: `${args.message?.id ?? "symbols"}:${index}` },
        }).catch((error) => ({result: mcpToolErrorPayload("symbol.get batch item execution failed", {
          code: "batch_item_execution_failed",
          message: error?.message || "symbol.get batch item execution failed",
        })}))));
      const batchMaxPhysicalCalls = researchSynthesisPolicyFor(args.session).maxPhysicalCalls;
      const batchAdmission = { tracked: String(boot.role || "") === "researcher", assignedPhysicalCallStep: physicalStep,
        physicalCeilingGrace: args.physicalCeilingGrace === true,
        blocked: args.physicalCeilingGrace !== true && physicalStep > batchMaxPhysicalCalls,
        maxPhysicalCalls: batchMaxPhysicalCalls,
        reservedPhysicalCalls: () => this._researchCallReservations.get(researchBudgetKey(boot)) };
      const batchResult = appendResearchWorkBudget(
        projectAtlasModelResult(
          combineSymbolGetBatchResults(responses.map(response => response.result), plan.overflow),
          args.session,
          "atlas.symbol.get",
          args.toolArgs || {},
        ),
        batchAdmission,
      );
      const noticedBatchResult = appendAndRecordResearchBudgetNotice(batchResult, batchAdmission, args.session, "symbol.get");
      return mcpToolResultMessage(args.message, noticedBatchResult);
    }
    if (args.physicalRequest) args.physicalRequest.expandedCalls++;
    const enqueuedAt = Date.now();
    const researchExploration = String(boot.role || "") === "researcher"
      && isResearchAtlasExplorationAction(effectiveAction);
    const researchPhysicalWork = String(boot.role || "") === "researcher"
      && isResearchPhysicalWorkRequest(requested);
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
    const assignedPhysicalCallStep = researchPhysicalWork
      ? (Number.isSafeInteger(args?.assignedPhysicalCallStep)
          ? args.assignedPhysicalCallStep
          : this._reserveResearchPhysicalCall(args?.session, requested))
      : null;
    if (args.physicalRequest) args.physicalRequest.physicalStep ??= assignedPhysicalCallStep;
    const synthesisAdmission = researchExploration && researchBatch?.admission
      ? {
          ...ownerResearchSynthesisAdmission(args?.session, effectiveAction, {
            assignedExplorationStep: researchBatch.admission.assignedExplorationStep,
            assignedPhysicalCallStep,
            explorationUnitWeight: researchBatch.admission.explorationUnitWeight,
            symbolFollowupDiscounted,
            physicalCeilingGrace: args?.physicalCeilingGrace === true,
            sameStepRecovery: args?.sameStepRecovery === true,
          }),
          explorationUnitId: researchBatch.admission.explorationUnitId,
          explorationUnitKind: researchBatch.admission.explorationUnitKind,
          explorationUnitWeight: researchBatch.admission.explorationUnitWeight,
          symbolFollowupDiscounted,
        }
      : (researchPhysicalWork
          ? ownerResearchSynthesisAdmission(args?.session, effectiveAction, {
              assignedPhysicalCallStep,
              physicalCeilingGrace: args?.physicalCeilingGrace === true,
              sameStepRecovery: args?.sameStepRecovery === true,
            })
          : null);
    if (synthesisAdmission) Object.assign(synthesisAdmission, {
      physicalRequestId: args.physicalRequest?.id,
      reservedPhysicalCalls: () => this._researchCallReservations.get(researchBudgetKey(boot)),
    });
    if (synthesisAdmission && args.physicalBatchId) Object.assign(synthesisAdmission, {physicalBatchId: args.physicalBatchId});
    if (researchBatch && isTerminalResearchExplorationAdmission(synthesisAdmission)) {
      researchBatch.terminal = true;
    }
    // Recoveries (and the symbol.get batch items they fan out to) run inside
    // the call that triggered them. They carry that call's queue slot so they
    // execute in it instead of queueing behind it, which would wait on itself.
    const slotArgs = { ...args, atlasQueueSlot: queueKey };
    const executeWithRecovery = () => observeAtlasExecution(args.physicalRequest,
      () => this._executeAtlasToolCallNow({
        ...args,
        binding,
        synthesisAdmission,
        enqueuedAt,
      }), async (executed) => {
      const recovered = await this._recoverSameFileAmbiguity(executed, slotArgs, assignedPhysicalCallStep);
      const widened = await this._recoverEmptyIdentifierFilter(recovered, slotArgs, assignedPhysicalCallStep);
      const surveyed = await this._recoverLensDirectory(widened, slotArgs, assignedPhysicalCallStep);
      return this._resolveExactNameSearch(surveyed, slotArgs, assignedPhysicalCallStep);
    });
    if (args?.atlasQueueSlot === queueKey) return executeWithRecovery();
    const concurrentResearchRead = researchExploration
      && CONCURRENT_RESEARCH_ATLAS_ACTIONS.has(effectiveAction)
      && !this._atlasToolCallQueues.has(queueKey);
    if (concurrentResearchRead) {
      const current = executeWithRecovery();
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
        return executeWithRecovery();
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

  /**
   * A name with several declarations inside the one file the caller named is
   * answerable: every bearer is in that file. Re-issue the read as a batch of
   * its exact symbolIds on the same physical step, so each body goes through
   * the per-item source custody that makes it citable. Answering below this
   * layer would return bodies the evidence ledger never saw.
   *
   * @param {any} message
   * @param {any} args
   * @param {number|null} assignedPhysicalCallStep
   */
  async _recoverSameFileAmbiguity(message, args, assignedPhysicalCallStep) {
    if (args?.ambiguityRecovery) return message;
    const requested = requestedToolPolicyName(args?.toolName, args?.toolArgs);
    if (effectiveAtlasResearchAction(requested) !== "symbol.get") return message;
    const toolArgs = args?.toolArgs?.args && typeof args.toolArgs.args === "object"
      ? args.toolArgs.args
      : (args?.toolArgs || {});
    const items = sameFileAmbiguityBatchItems(message?.result, toolArgs);
    if (!items) return message;
    const recovered = await this._executeAtlasToolCall({
      ...args,
      ambiguityRecovery: true,
      assignedPhysicalCallStep,
      sameStepRecovery: true,
      toolArgs: {
        items,
        ...(toolArgs.maxTokens == null ? {} : { maxTokens: toolArgs.maxTokens }),
      },
    });
    if (recovered?.result?.isError === true) return message;
    // The triggering read was already recorded as a failed tool.atlas row.
    // Record that the caller received the bodies, so a failure count can tell
    // an answered ambiguity from one the agent actually saw (Atlas594: 78
    // logged, 8 seen).
    const boot = args?.session?.bootConfig;
    if (boot?.attemptId != null) {
      recordObservation({
        work_item_id: boot.workItemId ?? null,
        job_id: boot.jobId ?? null,
        attempt_id: boot.attemptId,
        observation_type: "atlas.ambiguity_recovered",
        summary: `symbol.get ambiguity answered with ${items.length} same-file bearers`,
        detail: {
          action: "symbol.get",
          recovered_error: "ambiguous_symbol",
          bearers: items.length,
          physical_call_step: Number.isSafeInteger(assignedPhysicalCallStep) ? assignedPhysicalCallStep : null,
          physical_request_id: args?.physicalRequest?.id ?? null,
          mcp_request_id: args?.message?.id ?? null,
        },
      });
    }
    return recovered || message;
  }

  /**
   * An outline or survey narrowed to identifiers that are not declaration
   * names filters every row away, and the caller is charged a full retrieval
   * call for an empty result. Re-issue it unnarrowed on the same physical
   * step and say which identifiers were not declarations there. These reads
   * are served by the native binary, so the recovery belongs here rather than
   * in the JavaScript handler.
   *
   * @param {any} message
   * @param {any} args
   * @param {number|null} assignedPhysicalCallStep
   */
  async _recoverEmptyIdentifierFilter(message, args, assignedPhysicalCallStep) {
    if (args?.identifierFilterRecovery || args?.ambiguityRecovery) return message;
    const requested = requestedToolPolicyName(args?.toolName, args?.toolArgs);
    const action = effectiveAtlasResearchAction(requested);
    if (!["code.skeleton", "code.survey"].includes(action)) return message;
    const nested = args?.toolArgs?.args && typeof args.toolArgs.args === "object" && !Array.isArray(args.toolArgs.args);
    const toolArgs = nested ? args.toolArgs.args : (args?.toolArgs || {});
    const filtered = emptyIdentifierFilterRecovery(action, message?.result, toolArgs);
    if (!filtered) return message;
    const widened = { ...toolArgs };
    for (const field of IDENTIFIER_FILTER_FIELDS) delete widened[field];
    const recovered = await this._executeAtlasToolCall({
      ...args,
      identifierFilterRecovery: true,
      assignedPhysicalCallStep,
      sameStepRecovery: true,
      toolArgs: nested ? { ...args.toolArgs, args: widened } : widened,
    });
    const result = recovered?.result;
    if (!result || result.isError === true) return message;
    return {
      ...recovered,
      result: appendOwnerModelControlNotice(
        result,
        `\n\nIDENTIFIERS NOT DECLARED HERE: ${filtered.join(", ")}. `
          + "identifiers_to_find selects indexed declaration names, not usages, phrases or qualified spellings, "
          + "so the unnarrowed result is returned instead.",
        { kind: "atlas_identifier_filter_widened", trigger: action },
      ),
    };
  }

  /**
   * code.lens reads one file. Handed a directory it answered not_a_file and
   * the caller had to spend another call on code.survey; survey over that
   * directory with the same identifiers is what was asked, so it runs on the
   * same physical step.
   *
   * @param {any} message
   * @param {any} args
   * @param {number|null} assignedPhysicalCallStep
   */
  async _recoverLensDirectory(message, args, assignedPhysicalCallStep) {
    if (args?.lensDirectoryRecovery || args?.identifierFilterRecovery || args?.ambiguityRecovery) return message;
    const requested = requestedToolPolicyName(args?.toolName, args?.toolArgs);
    if (effectiveAtlasResearchAction(requested) !== "code.lens") return message;
    const nested = args?.toolArgs?.args && typeof args.toolArgs.args === "object" && !Array.isArray(args.toolArgs.args);
    const toolArgs = nested ? args.toolArgs.args : (args?.toolArgs || {});
    const directory = lensDirectoryTarget(message?.result, toolArgs);
    if (!directory) return message;
    const surveyArgs = { paths: [directory] };
    for (const field of IDENTIFIER_FILTER_FIELDS) {
      if (toolArgs[field] != null) surveyArgs[field] = toolArgs[field];
    }
    const recovered = await this._executeAtlasToolCall({
      ...args,
      lensDirectoryRecovery: true,
      assignedPhysicalCallStep,
      sameStepRecovery: true,
      toolName: String(args?.toolName || "").replace(/code[._]lens/u, (match) => match.replace("lens", "survey")),
      toolArgs: nested ? { ...withNestedAtlasAction(args.toolArgs, "code.survey"), args: surveyArgs } : surveyArgs,
    });
    const result = recovered?.result;
    if (!result || result.isError === true) return message;
    return {
      ...recovered,
      result: appendOwnerModelControlNotice(
        result,
        `\n\n${directory} is not a file; code.lens reads one file, so code.survey over it is returned instead.`,
        { kind: "atlas_lens_directory_survey", trigger: "code.lens" },
      ),
    };
  }

  /**
   * An exact name-scope search is a locator. When it finds exactly one
   * declaration, fetch that body on the same physical step instead of making
   * the caller spend a second call on symbol.get; when it finds none, return
   * the nearest indexed names rather than an empty list. The body is read
   * through symbol.get here, in the owner, so it carries the per-item source
   * custody that makes it citable.
   *
   * @param {any} message
   * @param {any} args
   * @param {number|null} assignedPhysicalCallStep
   */
  async _resolveExactNameSearch(message, args, assignedPhysicalCallStep) {
    if (args?.exactNameRecovery || args?.ambiguityRecovery || args?.identifierFilterRecovery) return message;
    const requested = requestedToolPolicyName(args?.toolName, args?.toolArgs);
    if (effectiveAtlasResearchAction(requested) !== "symbol.search") return message;
    const nested = args?.toolArgs?.args && typeof args.toolArgs.args === "object" && !Array.isArray(args.toolArgs.args);
    const toolArgs = nested ? args.toolArgs.args : (args?.toolArgs || {});
    const query = exactNameSearchQuery(toolArgs);
    const target = exactNameSearchTarget(message?.result, toolArgs);
    if (target?.oversized) {
      return {
        ...message,
        result: appendOwnerModelControlNotice(
          message.result,
          `\n\n${query} has one declaration (${target.kind}, lines ${target.span.start}-${target.span.end}); `
            + `its ${target.span.count}-line body was not fetched. Read only the parts you need.`,
          { kind: "atlas_exact_name_oversized", trigger: "symbol.search" },
        ),
      };
    }
    if (target) {
      const fetched = await this._executeAtlasToolCall({
        ...args,
        exactNameRecovery: true,
        assignedPhysicalCallStep,
        sameStepRecovery: true,
        toolName: String(args?.toolName || "").replace(/symbol[._]search/u, (match) => match.replace("search", "get")),
        toolArgs: nested
          ? { ...withNestedAtlasAction(args.toolArgs, "symbol.get"), args: { items: [target] } }
          : { items: [target] },
      });
      const result = fetched?.result;
      if (!result || result.isError === true) return message;
      return {
        ...fetched,
        result: appendOwnerModelControlNotice(
          result,
          `\n\n${query} has one declaration.`,
          { kind: "atlas_exact_name_body", trigger: "symbol.search" },
        ),
      };
    }
    const nearest = nearestNameSearchArgs(message?.result, toolArgs);
    if (!nearest) return message;
    const widened = await this._executeAtlasToolCall({
      ...args,
      exactNameRecovery: true,
      assignedPhysicalCallStep,
      sameStepRecovery: true,
      toolArgs: nested ? { ...args.toolArgs, args: nearest } : nearest,
    });
    const items = searchResultItems(widened?.result);
    if (!items || items.length === 0) return message;
    return {
      ...widened,
      result: appendOwnerModelControlNotice(
        widened.result,
        `\n\nNo declaration is named ${query}; these are the nearest indexed names.`,
        { kind: "atlas_nearest_names", trigger: "symbol.search" },
      ),
    };
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
    let requested = requestedToolPolicyName(toolName, toolArgs);
    const ceilings = clampAtlasArgumentCeilings(effectiveAtlasResearchAction(requested), toolArgs);
    if (ceilings.clamps.length > 0) {
      toolArgs = ceilings.args;
      requested = requestedToolPolicyName(toolName, toolArgs);
      providerTransforms = [...providerTransforms, {
        kind: "atlas_argument_ceiling_clamp",
        action: effectiveAtlasResearchAction(requested),
        clamps: ceilings.clamps,
      }];
    }
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
            physical_call_ceiling: admissionMaxPhysicalCalls(synthesisAdmission),
            symbol_followups_discounted: synthesisAdmission.symbolFollowupsDiscounted,
            stale_steps: synthesisAdmission.staleSteps,
            reason: synthesisAdmission.blockReason || "closeout",
            mcp_request_id: message?.id ?? null,
          },
        });
      }
      const guidanceEnabled = resolveAtlasResearchRuntimeGuidance();
      const gateText = synthesisAdmission.citationFetch
        ? buildResearchCitationFetchGateText({
          reason: synthesisAdmission.blockReason,
          handoffToolName: agentHandoffCallableName(session),
        })
        : buildResearchSynthesisRequiredText({
          explorationSteps: synthesisAdmission.explorationSteps,
          staleSteps: synthesisAdmission.staleSteps,
          absoluteCeilingReached: ["exploration_ceiling", "physical_call_ceiling"].includes(synthesisAdmission.blockReason),
          finalTraversalAvailable: synthesisAdmission.blockReason !== "physical_call_ceiling",
          handoffToolName: agentHandoffCallableName(session),
        });
      let result = guidanceEnabled
        ? tagOwnerModelControlNotice({
            content: [{
              type: "text",
              text: gateText,
            }],
            // Closeout and final-fetch gates are terminal admission decisions,
            // not execution failures. A normal MCP result prevents provider
            // tool-error recovery from reopening the exploration tail.
            isError: false,
          }, gateText, {
            kind: synthesisAdmission.citationFetch
              ? "research_citation_fetch_gate"
              : "research_closeout_gate",
            trigger: synthesisAdmission.blockReason,
            explorationStep: synthesisAdmission.assignedExplorationStep,
          })
        : unguidedResearchBlockedPayload(synthesisAdmission.blockReason || "research_closeout", session);
      if (!synthesisAdmission.physicalBatchId) result = preserveOwnerModelControlNotices(result, appendResearchWorkBudget(result, synthesisAdmission));
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
      if (["code.window", "symbol.get"].includes(requested.name)) {
        recordSourceSelectionObservations({
          session,
          toolArgs,
          action: requested.name,
          entries: sourceSelectionItems(toolArgs).map(() => ({
            outcome: "blocked",
            reason: synthesisAdmission.blockReason || "research_closeout",
            reasonClass: "suppression",
          })),
        });
      }
      recordOwnerToolObservation({
        session,
        toolName,
        toolArgs,
        result,
        outcomeOverride: "rejected",
        synthesisAdmission,
        durationMs: Date.now() - startedAt,
        queueWaitMs,
        executor: { via: "research_synthesis_gate" },
        observationDetail: {
          executed: false,
          consumed_step: false,
          budget_rejected: true,
          rejection_reason: synthesisAdmission.blockReason || "research_closeout",
          attempted_physical_call_step: synthesisAdmission.assignedPhysicalCallStep ?? null,
        },
      });
      return mcpToolResultMessage(message, result);
    }
    const argumentRepair = researcherTypedArgumentRepair(session, toolName, toolArgs);
    if (argumentRepair) {
      let result = argumentRepair.result;
      for (const transform of providerTransforms) {
        result = annotateOwnerResultTransform(result, transform);
      }
      result = appendOwnerResearchSynthesisNotice(
        result,
        session,
        toolName,
        synthesisAdmission,
        toolArgs,
      );
      result = appendOwnerOperatorFeedbackDelivery(result, session, toolName);
      recordOwnerToolObservation({
        session,
        toolName,
        toolArgs,
        result,
        outcomeOverride: "succeeded",
        synthesisAdmission,
        durationMs: Date.now() - startedAt,
        queueWaitMs,
        executor: { via: "typed_dispatcher_argument_repair" },
        observationDetail: {
          executed: true,
          consumed_step: true,
          native_executed: false,
          contract_repair: true,
          contract_error: argumentRepair.problem,
        },
      });
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.atlas_argument_repair",
        ...context,
        outcome: "repair_required",
        tool_name: toolName,
        action: argumentRepair.action,
        native_executed: false,
        duration_ms: Date.now() - startedAt,
        queue_wait_ms: queueWaitMs,
      });
      return mcpToolResultMessage(message, result);
    }
    try {
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
              // fetch_ref is an alias of traverse_ref: every role, on every
              // path, follows only refs issued to it as traversals.
              requireTraversal: true,
            });
        const deliveredRefs = createRef
          ? []
          : deliveredTraversalRefs(traversalText, traversalInputs.refs);
        for (const ref of deliveredRefs) priorDeliveredTraversalRefs.add(ref);
        let result = createRef
          ? createRefMcpPayload(createHashRefResult(toolArgs || {}, hashContext))
          : fetchRefMcpPayload(traversalText);
        noteResearcherTypedTraversalPromotion(session, toolName, toolArgs, result);
        if (!createRef) result = finalizeSourceTransport(result, hashContext.context);
        result = projectAtlasModelResult(
          result,
          session,
          toolName,
          toolArgs,
        );
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
        result = appendOwnerResearchFinalFetchNotice(result, synthesisAdmission, session);
        result = appendOwnerResearchSynthesisNotice(
          result,
          session,
          toolName,
          synthesisAdmission,
          toolArgs,
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
      const sourceAdmissionOwner = ["code.window", "symbol.get"].includes(requested.name);
      const coverageOwner = sourceAdmissionOwner || ["symbol.card", "code.skeleton", "code.lens"].includes(requested.name)
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
        result = appendOwnerResearchSynthesisNotice(result, session, toolName, synthesisAdmission, toolArgs);
        recordOwnerToolObservation({
          session, toolName, toolArgs, result,
          durationMs: Date.now() - startedAt,
          queueWaitMs,
          executor: { via: "source_coverage" },
          observationDetail: {
            source_coverage_outcome: "covered",
            source_coverage_reason: coveredAdmission.reason || "covered_reuse",
            selector_fingerprint: sourceSelectorFingerprint(toolArgs || {}),
            matched_selector_fingerprint: coveredAdmission.coverageRecord?.selector_fingerprint || null,
            covered_range: coveredAdmission.coverageRecord ? {
              path: coveredAdmission.coverageRecord.repo_rel_path || null,
              start_line: coveredAdmission.coverageRecord.start_line || null,
              end_line: coveredAdmission.coverageRecord.end_line || null,
            } : null,
          },
          synthesisAdmission,
        });
        recordSourceSelectionObservations({
          session,
          toolArgs,
          action: requested.name,
          coverageOwner,
          coverageCursor: coverageObservationCursor,
          entries: windowSelections.map((_, index) => (
            coveredSourceSelectionObservation(coverageAdmissions[index])
          )),
        });
        return mcpToolResultMessage(message, result);
      }
      const executorArgs = researcherStructureExecutorArgs(
        session,
        requested.name,
        compactCallerExecutorArgs(
          session,
          requested.name,
          toolArgs && typeof toolArgs === "object" ? toolArgs : {},
        ),
      );
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
        const guidanceEnabled = resolveAtlasResearchRuntimeGuidance();
        const result = mcpToolTextPayload(JSON.stringify({
          status: "blocked",
          executed: false,
          reason: `context_headroom_${contextHeadroom.reason}`,
          predictedNextRequestTokens: contextHeadroom.predicted,
          longContextThresholdTokens: contextHeadroom.threshold,
          requestedResultTokens: contextHeadroom.requestedResultTokens,
          availableResultTokens: contextHeadroom.availableResultTokens,
          ...(!guidanceEnabled
            ? { message: "Source read blocked by the context budget; no action was performed." }
            : (contextHeadroom.remediable && requested.name === "code.window"
            ? {
              nextAction: {
                action: "code.window",
                instruction: `Re-issue this same scalar selection with maxTokens at most ${contextHeadroom.availableResultTokens}.`,
              },
              message: `Near the long-context tier, each source read must declare a result bound that fits the remaining budget: re-issue this scalar code.window with maxTokens at most ${contextHeadroom.availableResultTokens}. Independent scalar calls may still be issued together, but they share that remaining budget. Stored evidence re-access and final handoff remain available.`,
            }
            : {
              message: "No source-read budget remains before the long-context tier. Do not retry this read at any maxTokens. Use the evidence already gathered, re-access stored refs, and hand off.",
            })),
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
          action: requested.name,
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
        config: { hashRefContext: hashRefToolContext(session) },
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
      rememberCompactCallerPageVersion(session, requested.name, executorArgs, result);
      // Envelope composition: measure what each owner-side stage adds to (or
      // removes from) the model-visible payload, so the per-call envelope
      // (result_chars − source_chars) decomposes into named parts instead of
      // one opaque residual. Character counting only; no behavior change.
      const responseComposition = { executor_chars: mcpResultTextChars(result) };
      const composed = (label, next) => {
        const delta = mcpResultTextChars(next) - mcpResultTextChars(result);
        if (delta !== 0) responseComposition[label] = (responseComposition[label] || 0) + delta;
        return next;
      };
      let resolvedCoverageSuppression = null;
      let resolvedCoverageReuseNotice = null;
      const selectorHasUnseenContinuation = coverageAdmissions.some(
        (admission) => admission?.reason === "continuation_unseen",
      );
      if (coverageOwner && !selectorHasUnseenContinuation) {
        resolvedCoverageSuppression = await suppressCoveredSourceInterval(
          result,
          coverageOwner,
          toolArgs || {},
          { toolName: requested.name },
        );
        if (resolvedCoverageSuppression.reservation && resolvedCoverageSuppression.reservation !== "joined") {
          coverageReservationsToRelease.push({
            owner: coverageOwner,
            reservation: resolvedCoverageSuppression.reservation,
          });
        }
        result = composed("coverage_suppress", resolvedCoverageSuppression.result);
        if (resolvedCoverageSuppression.admission) {
          const reuseNotice = resolvedCoverageSuppressionNotice(
            coverageOwner,
            resolvedCoverageSuppression,
          );
          if (reuseNotice) {
            resolvedCoverageReuseNotice = reuseNotice;
            const first = result.content[0];
            const suffixAt = first.text.indexOf("\n\n[");
            const suffix = suffixAt >= 0 ? first.text.slice(suffixAt) : "";
            const noticeResult = {
              ...result,
              content: [{ ...first, text: `${JSON.stringify({
                ...resolvedCoverageSuppression.payload,
                message: reuseNotice,
              })}${suffix}` }, ...result.content.slice(1)],
            };
            result = composed("coverage_suppress_notice", noticeResult);
          }
        }
      }
      if (coverageOwner) {
        result = composed("coverage_prepare", prepareSourceCoverage(result, coverageOwner, toolArgs || {}, { toolName: requested.name }));
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
      if (String(session?.bootConfig?.role || "") === "researcher" && requested.name === "symbol.search") {
        result = composed("search_presentation", compactResearchSearchResult(result));
      }
      result = composed("symbol_handles", appendResearcherSymbolHandles(result, session, requested.name));
      result = composed("hash_ref_surface", appendHashRefToMcpTextResult(result, toolName, toolArgs, session));
      noteResearcherTypedTraversalPromotion(session, toolName, toolArgs, result);
      if (coverageOwner) {
        result = composed("coverage_materialize", await materializeDisplayedSourceCoverage(result, coverageOwner, toolArgs || {}, { toolName: requested.name }));
      }
      result = composed("thin_implementation_gap_notice", appendOwnerThinImplementationGapNotice(
        result,
        session,
        requested,
        undefined,
        evidenceResult,
      ));
      result = composed("compaction", compactResearcherTypedAtlasResult(result, session, toolName, toolArgs));
      result = composed("source_transport_finalize", finalizeSourceTransport(result, hashRefToolContext(session)));
      result = composed("field_names", projectAtlasModelResult(
        result,
        session,
        toolName,
        toolArgs,
      ));
      if (String(session?.bootConfig?.role || "") === "researcher" && requested.name === "symbol.search") {
        result = composed("search_rows", compactResearchSearchRows(result));
      }
      for (const transform of providerTransforms) {
        result = composed("transform_annotations", annotateOwnerResultTransform(result, transform));
      }
      if (resolvedCoverageReuseNotice) {
        result = tagOwnerModelControlNotice(result, resolvedCoverageReuseNotice, {
          kind: SOURCE_EVIDENCE_REUSE_NOTICE_KIND,
          trigger: resolvedCoverageSuppression.admission.reason || "contained_interval",
        });
      }
      for (const admission of coverageAdmissions) {
        coverageOwner?.settleReservation(admission.reservation, result?.isError ? "failed" : "confirmed");
      }
      if (resolvedCoverageSuppression?.reservation && resolvedCoverageSuppression.reservation !== "joined") {
        coverageOwner?.settleReservation(
          resolvedCoverageSuppression.reservation,
          result?.isError ? "failed" : "confirmed",
        );
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
      result = composed("operator_feedback", appendOwnerOperatorFeedbackDelivery(result, session, toolName));
      result = composed("synthesis_notice", appendOwnerResearchSynthesisNotice(
        result,
        session,
        toolName,
        synthesisAdmission,
        toolArgs,
      ));
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
        coverageOwner,
        coverageCursor: coverageObservationCursor,
        responseComposition,
        observationDetail: resolvedCoverageSuppression?.admission ? {
          source_coverage_suppressed: true,
          source_coverage_reason: resolvedCoverageSuppression.admission.reason,
          resolved_source_chars: resolvedCoverageSuppression.resolvedChars,
          suppressed_source_chars: resolvedCoverageSuppression.suppressedChars,
          source_coverage_partial: resolvedCoverageSuppression.admission.partial === true,
          selector_alias_recorded: resolvedCoverageSuppression.selectorAliased === true,
        } : null,
      });
      if (coverageOwner && windowSelections.length > 0) {
        recordSourceSelectionObservations({
          session,
          toolArgs,
          action: requested.name,
          coverageOwner,
          coverageCursor: coverageObservationCursor,
          evidenceResult,
          entries: windowSelections.map((_, index) => {
            const admission = coverageAdmissions[index];
            if (admission?.covered) return coveredSourceSelectionObservation(admission);
            if (resolvedCoverageSuppression?.admission) {
              return suppressedSourceSelectionObservation(
                resolvedCoverageSuppression.admission,
                resolvedCoverageSuppression.resolvedChars,
                resolvedCoverageSuppression.suppressedChars,
              );
            }
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
        toolArgs,
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
      if (["code.window", "symbol.get"].includes(requested.name)) {
        recordSourceSelectionObservations({
          session,
          toolArgs,
          action: requested.name,
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

  async _scheduleAtlasWriteRefresh({ message, session, response, telemetryContext = null }) {
    const toolName = String(message?.params?.name || "");
    const toolArgs = message?.params?.arguments || {};
    const requested = requestedToolPolicyName(toolName, toolArgs);
    if (requested.suite !== "tools") return null;
    if (!ATLAS_MUTATION_PATH_FIELDS[requested.name]) return null;
    const startedAt = Date.now();
    const refreshTelemetryContext = telemetryContext || attachTelemetryContext(session, this.bootId);
    const executor = getSharedAtlasToolExecutor();
    const scheduled = await executor.scheduleDeterministicWriteRefresh({
      toolName: requested.name,
      args: toolArgs && typeof toolArgs === "object" ? toolArgs : {},
      config: atlasWriteRefreshViewMode(session),
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
      ...refreshTelemetryContext,
      outcome: scheduled ? (scheduled.ok === false ? "tool_error" : "ok") : "skipped",
      tool_name: requested.name,
      path: typeof toolArgs?.path === "string" ? capString(toolArgs.path, 240) : null,
      duration_ms: Date.now() - startedAt,
      scheduled: !!scheduled,
      detail: scheduled ? {
        action: scheduled.action || null,
        deferred: scheduled.deferred === true,
        via: scheduled.via || null,
        branch: scheduled.branch || null,
        paths: scheduled.paths || null,
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
