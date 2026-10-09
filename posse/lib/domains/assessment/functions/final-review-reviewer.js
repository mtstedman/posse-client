// Run the final review's reviewer: a fresh, read-only assessor child call of
// the developer's agent call. Its prompt is the remote assessor composition
// for the job plus the local snapshot; it reads files with its issued read
// tools and ends with the ordinary assessor verdict. It is labeled
// final_reviewer, so it neither spends the job's assessment call budget nor
// counts as the independent assessment that follows the handoff.

import { getJob, getWorkItem } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { buildHandoffPacket, handoff } from "../../handoff/functions/index.js";
import { getAgentHandoffRecord } from "../../handoff/functions/agent-handoff.js";
import { extractJsonResult } from "../../../shared/format/functions/json.js";
import { AGENT_CALL_CHILD_KINDS, AGENT_CALL_ROLE_LABELS } from "../../../catalog/agent-call.js";

/**
 * @param {{
 *   call: (prompt: string, opts: object, context: object) => Promise<any>,
 *   composePrompt: (packet: object, instructions: string, opts: object) => Promise<string>,
 *   jobId: number, workItemId: number, attemptId: number | null, cwd: string,
 *   providerName: string, parentAgentCallId: number, abortSignal?: AbortSignal | null,
 *   instructions: string, evidence: string,
 * }} input
 */
export async function runFinalReviewer({
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
  });
  // The reviewer reports with final_review and waits in it for the
  // developer's revisions; it needs the handoff protocol for its final verdict.
  if (packet.agent_coordination?.agent_handoff_v1 === true) {
    packet.agent_coordination = { ...packet.agent_coordination, final_review_v1: true };
  }
  try {
    await handoff(packet, { providerName });
  } catch {
    // Context enrichment is optional; the snapshot carries the evidence.
  }
  const composed = await composePrompt(packet, instructions, { providerName });
  const result = await call([composed, evidence].filter(Boolean).join("\n\n"), {
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
    remoteSystemPrompt: packet.remote_system_prompt || null,
    abortSignal,
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
  });
  const { _normalizeAssessorVerdictShape } = await import("../../worker/functions/helpers/assessment-pipeline.js");
  let parsed = extractJsonResult(result?.output || "").value;
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  const handoffPacket = Number.isInteger(result?.agentCallId) ? getAgentHandoffRecord(result.agentCallId)?.packet : null;
  return {
    verdict: _normalizeAssessorVerdictShape(parsed, result?.output || ""),
    claims: handoffPacket?.profile === "assessor.verdict.v1" && Array.isArray(handoffPacket?.handoffs?.[0]?.report?.claims)
      ? handoffPacket.handoffs[0].report.claims
      : [],
    agentCallId: Number.isInteger(result?.agentCallId) ? result.agentCallId : null,
  };
}
