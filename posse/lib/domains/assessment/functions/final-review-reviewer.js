// Run the final review's reviewer: a fresh, read-only assessor child call of
// the developer's agent call. Its prompt is the remote assessor composition
// for the job plus the local snapshot; it reads files with its issued read
// tools and ends with the ordinary assessor verdict. It is labeled
// final_reviewer; its durable verdict authorizes the reviewed change after
// handoff, subject to deterministic scope, identity, and verification checks.

import { getJob, getWorkItem } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { buildHandoffPacket, handoff } from "../../handoff/functions/index.js";
import { getAgentHandoffRecord } from "../../handoff/functions/agent-handoff-records.js";
import { extractJsonResult } from "../../../shared/format/functions/json.js";
import { AGENT_CALL_CHILD_KINDS, AGENT_CALL_ROLE_LABELS } from "../../../catalog/agent-call.js";
import { FINAL_REVIEW_REVIEWER_WALL_MS } from "../../../catalog/final-review.js";
import { AGENT_HANDOFF_PROFILES } from "../../../catalog/handoff.js";
import { runWithObservationContext } from "../../observability/functions/observations.js";
import {
  finalReviewCoreInstructions,
  finalReviewInstructions,
  finalReviewModeInstructions,
} from "./final-review-snapshot.js";

/**
 * @param {{
 *   call: (prompt: string, opts: object, context: object) => Promise<any>,
 *   composePrompt: (packet: object, instructions: string, opts: object) => Promise<string>,
 *   jobId: number, workItemId: number, attemptId: number | null, cwd: string,
 *   providerName: string, parentAgentCallId: number, abortSignal?: AbortSignal | null,
 *   instructions: string, evidence: string, wallMs?: number,
 *   atlasConfig?: object | null, disableAtlas?: boolean,
 * }} input
 */
async function runFinalReviewerInContext({
  call,
  composePrompt,
  jobId,
  workItemId,
  attemptId,
  cwd,
  providerName,
  parentAgentCallId,
  abortSignal = null,
  instructions,
  evidence,
  wallMs = FINAL_REVIEW_REVIEWER_WALL_MS,
  atlasConfig = null,
  disableAtlas = false,
}) {
  const job = getJob(jobId);
  if (!job) throw new Error(`Job #${jobId} no longer exists`);
  const packet = buildHandoffPacket(job, {
    workItem: getWorkItem(workItemId),
    payload: parseJobPayload(job),
    role: "assessor",
    attemptCount: 1,
    maxAttempts: 1,
    lastError: null,
    cwd,
    atlasConfig,
    disableAtlas,
    disableAtlasReason: disableAtlas ? "Parent worktree ATLAS attachment unavailable" : null,
  });
  // Handoff validates the parent call before issuing reviewer coordination.
  await handoff(packet, { providerName, reviewerChildIdentity: {
    kind: AGENT_CALL_CHILD_KINDS.FINAL_REVIEW,
    parentAgentCallId,
  } });
  // Composition issues the reviewer's tool surface, so how the reviewer
  // reports is chosen after it: full final-review instructions are reduced to
  // their mode-neutral core first. Only a surface that carries final_review
  // gets the report-and-wait lines; without an issued surface the reviewer
  // reports in its terminal handoff.
  const coreInstructions = [true, false].some((reportAndWait) => instructions === finalReviewInstructions({ reportAndWait }))
    ? finalReviewCoreInstructions() : instructions;
  const composed = await composePrompt(packet, coreInstructions, { providerName });
  const canReportAndWait = Array.isArray(packet.remote_tool_surface)
    && packet.remote_tool_surface.includes("tools.final_review");
  const modeInstructions = finalReviewModeInstructions({ reportAndWait: canReportAndWait });
  const wallSignal = AbortSignal.timeout(wallMs);
  const reviewerSignal = abortSignal ? AbortSignal.any([abortSignal, wallSignal]) : wallSignal;
  // A reviewer cut off by its wall has no verdict on the work, whatever its
  // partial output says: the round obtained no verdict (infrastructure).
  const wallExpired = () => wallSignal.aborted && !abortSignal?.aborted;
  const wallError = () => Object.assign(new Error("the reviewer reached its time limit before reporting"),
    { code: "FINAL_REVIEW_REVIEWER_WALL" });
  const result = await call([composed, modeInstructions, evidence].filter(Boolean).join("\n\n"), {
    role: "assessor",
    modelTier: "standard",
    reasoningEffort: "medium",
    activity: `final review: ${job.title || `job #${jobId}`}`,
    allowWrite: false,
    allowShell: false,
    allowTests: false,
    projectDbCapability: "none",
    projectDbWrite: false,
    needsImageGeneration: false,
    skipRolePrompt: !!packet.remote_prompt_composed,
    recyclingMode: "fresh",
    stableContext: packet.stable_context || null,
    sessionPacket: packet,
    atlasConfig,
    disableAtlas,
    remoteSystemPrompt: packet.remote_system_prompt || null,
    abortSignal: reviewerSignal,
    cwd,
    _parentAgentCallId: parentAgentCallId,
    _childKind: AGENT_CALL_CHILD_KINDS.FINAL_REVIEW,
    _agentCallRole: AGENT_CALL_ROLE_LABELS.FINAL_REVIEWER,
  }, {
    job_id: jobId,
    work_item_id: workItemId,
    attempt_id: attemptId,
    cwd,
    jobProvider: providerName,
    jobModelName: null,
    // The reviewer must not move the developer job's provider/model pin.
    persistJobProvider: false,
  }).catch((error) => { throw wallExpired() ? wallError() : error; });
  if (wallExpired()) throw wallError();
  const { _normalizeAssessorVerdictShape } = await import("../../worker/functions/helpers/assessment-pipeline.js");
  let parsed = extractJsonResult(result?.output || "").value;
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  const handoffPacket = Number.isInteger(result?.agentCallId) ? getAgentHandoffRecord(result.agentCallId)?.packet : null;
  return {
    verdict: _normalizeAssessorVerdictShape(parsed, result?.output || ""),
    claims: handoffPacket?.profile === AGENT_HANDOFF_PROFILES.ASSESSOR_VERDICT && Array.isArray(handoffPacket?.handoffs?.[0]?.report?.claims)
      ? handoffPacket.handoffs[0].report.claims
      : [],
    agentCallId: Number.isInteger(result?.agentCallId) ? result.agentCallId : null,
  };
}

/** @param {Parameters<typeof runFinalReviewerInContext>[0]} input */
export async function runFinalReviewer(input) {
  return runWithObservationContext({
    work_item_id: input.workItemId,
    job_id: input.jobId,
    attempt_id: input.attemptId,
    role: "assessor",
  }, () => runFinalReviewerInContext(input));
}
