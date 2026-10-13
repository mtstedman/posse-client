import { capString, ownerErrorSummary } from "./mcp-owner-session-support.js";
import { classifyMcpToolResult } from "../../../domains/integrations/functions/deterministic-mcp/json-rpc.js";
import { recordObservation, recordToolUseObservations, isResearchInfrastructureFailure } from "../../../domains/observability/functions/observations.js";
import { recordOwnerModelControlNotice, effectiveAtlasResearchAction, attachTelemetryContext, OWNER_MODEL_CONTROL_NOTICES } from "./planner-triage.js";
import { RESPONSE_TRANSFORM_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { appendRunTelemetry } from "../../telemetry/functions/run-telemetry.js";
import { mcpResultTextChars, ownerAtlasPartialResultDiagnostic, ownerResultProjection, CLIENT_RESULT_CLIP_CHARS } from "./mcp-owner-source-transport.js";
import { ownerAtlasEvidenceIdentities, ownerSourceRangeEvidence, ownerWindowResponseRangeEvidence, ownerAtlasSourcePaths, ownerAtlasSymbolSourcePaths, OWNER_EVIDENCE_IDENTITY_VERSION } from "./mcp-owner-evidence.js";
import { requestedToolPolicyName } from "./mcp-owner-tool-policy.js";
import { rememberAtlasSymbolSourcePaths } from "./mcp-owner-symbol-handles.js";
import { admissionMaxPhysicalCalls } from "./mcp-owner-research-budget.js";

function mcpToolResultErrorText(result = null) {
  const structured = result?.structuredContent?.error?.message || result?._meta?.atlasError?.message || "";
  if (structured) return capString(structured, 700);
  if (!result?.isError) return "";
  const contentText = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").filter(Boolean).join("\n")
    : "";
  return capString(contentText || "ATLAS tool returned an error", 700);
}

export function ownerToolStructuredError(result = null, error = null) {
  const structured = result?.structuredContent?.error || result?._meta?.atlasError || null;
  const code = String(structured?.code || error?.code || "").trim() || null;
  const message = String(
    structured?.message
      || error?.message
      || mcpToolResultErrorText(result)
      || "",
  ).trim() || null;
  const status = String(structured?.details?.status || "").trim() || null;
  const reason = typeof structured?.details?.reason === "string"
    ? capString(structured.details.reason, 300) : null;
  return {
    ...(code ? { error_code: code } : {}),
    ...(message ? { error_message: message } : {}),
    ...(status ? { error_status: status } : {}),
    ...(reason ? { error_reason: reason } : {}),
  };
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
 *   coverageOwner?: any,
 *   coverageCursor?: number,
 *   responseComposition?: Record<string, number> | null,
 *   outcomeOverride?: "succeeded"|"failed"|"rejected"|null,
 * }} [observation]
 */
export function recordOwnerToolObservation({
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
  coverageOwner = null,
  coverageCursor = 0,
  responseComposition = null,
  outcomeOverride = null,
} = {}) {
  const boot = session?.bootConfig || {};
  const outcome = outcomeOverride || (error ? "failed" : classifyMcpToolResult(result));
  const resultChars = mcpResultTextChars(result);
  const errorText = error
    ? capString(error?.message || String(error), 700)
    : mcpToolResultErrorText(result);
  const structuredError = ownerToolStructuredError(result, error);
  const infrastructureFailure = (error || result?.isError === true)
    && isResearchInfrastructureFailure(structuredError);
  const collectedEvidenceIdentities = ownerAtlasEvidenceIdentities({
    session,
    toolName,
    toolArgs,
    result: evidenceResult || result,
    outcome,
  });
  let sourceRangeEvidence = coverageOwner && outcome === "succeeded"
    ? ownerSourceRangeEvidence(coverageOwner, coverageCursor, toolArgs)
    : null;
  if (
    !sourceRangeEvidence
    && outcome === "succeeded"
    && ["code.window", "symbol.get"].includes(
      effectiveAtlasResearchAction(requestedToolPolicyName(toolName, toolArgs)),
    )
  ) {
    sourceRangeEvidence = ownerWindowResponseRangeEvidence(evidenceResult || result);
  }
  // Delivered coverage rows are the authoritative novelty substrate for a
  // source read: they say exactly which file lines entered the working set.
  // The result-derived identities (paths + content hashes) remain the contract
  // for every other action and for source reads that delivered nothing.
  const evidenceIdentities = sourceRangeEvidence && Array.isArray(collectedEvidenceIdentities)
    ? sourceRangeEvidence.identities
    : collectedEvidenceIdentities;
  const sourcePaths = ownerAtlasSourcePaths({
    toolName,
    toolArgs,
    result: evidenceResult || result,
    outcome,
  });
  const symbolSourcePaths = ownerAtlasSymbolSourcePaths({ result: evidenceResult || result, outcome });
  rememberAtlasSymbolSourcePaths(session, symbolSourcePaths);
  const partialResult = outcome === "succeeded"
    ? ownerAtlasPartialResultDiagnostic(evidenceResult || result, toolArgs)
    : null;
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
          projection: ownerResultProjection(result),
          executor: executor && typeof executor === "object" ? executor : null,
          ...(synthesisAdmission?.explorationUnitId ? {
            research_exploration_unit_version: 1,
            research_exploration_unit_id: synthesisAdmission.explorationUnitId,
            research_exploration_step: synthesisAdmission.assignedExplorationStep,
            research_exploration_unit_kind: synthesisAdmission.explorationUnitKind || "request",
            research_exploration_unit_weight: synthesisAdmission.explorationUnitWeight === 0 ? 0 : 1,
            symbol_followup_discounted: synthesisAdmission.symbolFollowupDiscounted === true,
          } : {}),
          ...(Number.isSafeInteger(synthesisAdmission?.assignedPhysicalCallStep) ? {
            physical_call_step: synthesisAdmission.assignedPhysicalCallStep,
            physical_call_ceiling: admissionMaxPhysicalCalls(synthesisAdmission),
            ...(synthesisAdmission.physicalCeilingGrace === true ? { physical_ceiling_grace: true } : {}),
          } : {}),
          ...(synthesisAdmission?.physicalRequestId ? {
            measurement_version: 1,
            measurement_unit: "expanded_call",
            physical_request_id: synthesisAdmission.physicalRequestId,
          } : {}),
          ...(synthesisAdmission?.physicalBatchId ? {
            research_physical_batch_version: 1,
            research_physical_batch_id: synthesisAdmission.physicalBatchId,
          } : {}),
          ...(observationDetail && typeof observationDetail === "object" ? observationDetail : {}),
          atlas_artifacts: result?._meta?.atlasArtifacts || null,
          atlas_batch: result?._meta?.atlasBatch || null,
          ...(result?._meta?.researchWorkBudget ? { research_work_budget: result._meta.researchWorkBudget } : {}),
          ...(result?._meta?.researchSearchDiagnostics ? { search_diagnostics: result._meta.researchSearchDiagnostics } : {}),
          ...(evidenceIdentities == null ? {} : {
            evidence_identity_version: OWNER_EVIDENCE_IDENTITY_VERSION,
            evidence_identities: evidenceIdentities,
          }),
          ...(sourcePaths == null ? {} : { source_paths: sourcePaths }),
          ...(symbolSourcePaths.length > 0 ? { symbol_source_paths: symbolSourcePaths } : {}),
          ...(partialResult ? { partial_result: partialResult } : {}),
          response: {
            result_chars: resultChars,
            content_blocks: Array.isArray(result?.content) ? result.content.length : 0,
            is_error: result?.isError === true,
            over_client_clip: resultChars > CLIENT_RESULT_CLIP_CHARS,
            // Payload composition: delivered source chars vs the envelope
            // (headers, handles, index blocks, refs) wrapped around them.
            ...(sourceRangeEvidence ? {
              source_chars: sourceRangeEvidence.sourceChars,
              envelope_chars: Math.max(0, resultChars - sourceRangeEvidence.sourceChars),
            } : {}),
            // Named char deltas of each owner-side payload stage, so the
            // envelope decomposes without re-deriving it offline.
            ...(responseComposition && typeof responseComposition === "object"
              ? { composition: responseComposition }
              : {}),
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

// Tools the owner answers itself (final_review, custom_tools, terminal
// handoffs and their rejections) never reach the gateway's invocation ledger.
// Without this row, provider-replay reconciliation records the call as a
// recovered, executed one.
export function recordOwnerAnsweredToolCall({
  session,
  toolName,
  toolArgs,
  result,
  startedAt = null,
  via,
  rejectionCode = null,
  observationDetail = null,
} = {}) {
  try {
    recordOwnerToolObservation({
      session,
      toolName,
      toolArgs,
      result,
      durationMs: startedAt == null ? 0 : Date.now() - startedAt,
      executor: { via },
      ...(observationDetail ? { observationDetail } : {}),
      ...(rejectionCode ? {
        outcomeOverride: "rejected",
        observationDetail: { executed: false, consumed_step: false, rejection_code: rejectionCode },
      } : {}),
    });
  } catch { /* telemetry only */ }
}
