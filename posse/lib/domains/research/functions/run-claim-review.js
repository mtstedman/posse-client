import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RESEARCH_CLAIM_REVIEW as POLICY } from "../../../catalog/research-claim-review.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getArtifacts, storeArtifact, getSetting } from "../../queue/functions/index.js";
import { getPromptBundleRolePrompt } from "../../remote/functions/prompt-bundle.js";
import { getLatestCommittedAgentHandoffPacket } from "../../handoff/functions/agent-handoff-implementation.js";
import { buildClaimReviewInput, claimReviewDigest, parseClaimReview } from "./claim-review.js";

// A separately tracked provider operation after research. The committed packet
// and researcher return value are never changed, including on review failure.
export async function runResearchClaimReview({ providerClient, job, ctx, stats }, deps = {}) {
  const setting = deps.getSetting || getSetting;
  if (setting(POLICY.setting) !== "shadow") return null;
  const getPacket = deps.getPacket || getLatestCommittedAgentHandoffPacket;
  const handoff = getPacket({ workItemId: job.work_item_id, jobId: job.id, attemptId: ctx.attemptId });
  if (!handoff?.packet || !handoff.packet.profile?.startsWith("researcher.")) return null;
  const input = buildClaimReviewInput(handoff.packet);
  if (!input.claims.length) return null;
  const packetDigest = handoff.packet_digest;
  const artifact = record => (deps.storeArtifact || storeArtifact)({
    work_item_id: job.work_item_id, job_id: job.id, attempt_id: ctx.attemptId,
    artifact_type: POLICY.artifactType, content_long: JSON.stringify({ kind: POLICY.artifactKind, ...record }),
  });
  const claim = () => {
    const previous = (deps.getArtifacts || getArtifacts)(job.id, POLICY.artifactType);
    if (previous.some(row => {
      try {
        const previousRecord = JSON.parse(row.content_long);
        return previousRecord.kind === POLICY.artifactKind && previousRecord.packet_digest === packetDigest;
      } catch { return false; }
    })) return false;
    artifact({ status: "started", packet_digest: packetDigest, started_at: new Date().toISOString() });
    return true;
  };
  if (!(deps.claim || (() => getDb().transaction(claim)()))()) return null;
  const record = {
    mode: "shadow", packet_digest: packetDigest,
    parent_agent_call_id: handoff.agent_call_id,
    input_sha256: claimReviewDigest(JSON.stringify(input)), input,
    started_at: new Date().toISOString(),
  };
  let cwd;
  try {
    const policy = (deps.getPolicy || getPromptBundleRolePrompt)(POLICY.promptProfile);
    record.policy_sha256 = claimReviewDigest(policy);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "posse-claim-review-"));
    const parentSignal = ctx.abortSignal || providerClient.worker?._abortControllers?.get(job.id)?.signal;
    const timeout = AbortSignal.timeout(POLICY.timeoutMs);
    const result = await providerClient.call(`${policy}\n\n${JSON.stringify(input)}`, {
      role: "researcher", _agentCallRole: "subagent", _childKind: POLICY.childKind,
      _parentAgentCallId: handoff.agent_call_id,
      modelName: stats.modelName || job._executionModelName || job.model_name,
      modelTier: stats.modelTier || ctx.tier || job.model_tier,
      reasoningEffort: "high", maxTurns: 1, maxOutputTokens: POLICY.maxOutputTokens,
      allowWrite: false, allowTests: false, disableAtlas: true,
      disableSystemTools: true, disableAgentTools: true, skipRolePrompt: true,
      projectDir: cwd, recyclingMode: "fresh", allowShell: false,
      projectDbCapability: "none", projectDbWrite: false,
      allowedProviders: [ctx.providerName], _fallbackAttempted: true, _modelFallbackAttempted: true,
      abortSignal: parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout,
      activity: "reviewing research claims (shadow)",
    }, {
      job_id: job.id, work_item_id: job.work_item_id, attempt_id: ctx.attemptId,
      cwd, jobProvider: ctx.providerName,
      jobModelName: stats.modelName || job.model_name,
    });
    record.output = result.output;
    record.stats = result.stats;
    if (result.stats?.outputTruncated || result.stats?.numTurns > 1 || result.stats?.toolUses?.length) throw new Error("Review exceeded its output/tool contract");
    record.review = parseClaimReview(result.output, input);
    record.status = "completed";
  } catch (error) {
    record.status = "failed";
    record.error = String(error?.message || error);
    if (error?.stats) record.stats = error.stats;
  } finally {
    record.finished_at = new Date().toISOString();
    artifact(record);
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
  }
  return record;
}
