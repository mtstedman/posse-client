// Strict research continuity resolver shared by planner prompt assembly and
// plan compilation. Only successful research jobs in the planner's ancestor
// graph are eligible; sibling, fan-out child, and shadow results never become
// implicit planning input.

import {
  getArtifacts,
  getArtifactsByWorkItem,
  getDependencies,
  getJob,
  listJobsByWorkItem,
} from "../../queue/functions/index.js";
import {
  getLatestCommittedAgentHandoffPacket,
  renderAgentHandoffCompatibilityOutput,
} from "../../handoff/functions/agent-handoff.js";
import {
  parseResearcherStructuredOutput,
  researcherPacketToStructuredOutput,
} from "../../handoff/functions/helpers/researcher-output.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { buildSyntheticResearchBrief } from "./routing.js";

const DEFAULT_DEPS = Object.freeze({
  getArtifacts,
  getArtifactsByWorkItem,
  getDependencies,
  getJob,
  getLatestCommittedAgentHandoffPacket,
  listJobsByWorkItem,
  recordObservation,
  renderAgentHandoffCompatibilityOutput,
});

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function continuityFault(message, cause = null) {
  const error = new Error(message);
  error.code = "RESEARCH_CONTINUITY_FAULT";
  if (cause) error.cause = cause;
  return error;
}

function plannerAncestors(plannerJob, deps) {
  const ancestors = new Set();
  const pending = [];
  const enqueue = (value) => {
    const id = positiveInt(value);
    if (id && !ancestors.has(id)) pending.push(id);
  };
  enqueue(plannerJob?.parent_job_id);
  for (const edge of deps.getDependencies(plannerJob.id) || []) {
    enqueue(edge.depends_on_job_id);
  }
  while (pending.length > 0) {
    const id = pending.shift();
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    const job = deps.getJob(id);
    if (!job) continue;
    enqueue(job.parent_job_id);
    for (const edge of deps.getDependencies(id) || []) enqueue(edge.depends_on_job_id);
  }
  return ancestors;
}

function acceptedResearchJob(job, workItemId, ancestors) {
  if (!job
    || positiveInt(job.work_item_id) !== workItemId
    || job.job_type !== "research"
    || job.status !== "succeeded"
    || !ancestors.has(positiveInt(job.id))) {
    return false;
  }
  const payload = parseJobPayload(job);
  const roleMode = String(payload?.role_mode || "solo").trim().toLowerCase();
  if (roleMode === "child" || payload?.fanout_shadow === true) return false;
  return roleMode === "solo" || roleMode === "synth" || roleMode === "normal";
}

function baseProvenance(source, {
  profile = null,
  workItemId,
  jobId = null,
  attemptId = null,
  agentCallId = null,
  packetDigest = null,
  freshness,
  fallbackReason = null,
} = {}) {
  return {
    source,
    profile,
    work_item_id: workItemId,
    job_id: jobId,
    attempt_id: attemptId,
    agent_call_id: agentCallId,
    packet_digest: packetDigest,
    freshness,
    fallback_reason: fallbackReason,
  };
}

function syntheticContext({ workItemId, reason, routing }, deps) {
  const artifact = (deps.getArtifactsByWorkItem(workItemId, "response") || [])
    .filter((candidate) => candidate.job_id == null)
    .sort((left, right) => positiveInt(right.id) - positiveInt(left.id))[0] || null;
  const storedBrief = String(artifact?.content_long || "");
  const storedStructured = parseResearcherStructuredOutput(storedBrief);
  const brief = storedStructured
    ? storedBrief
    : buildSyntheticResearchBrief(routing || reason || "deterministic no_research route");
  return {
    brief,
    structuredData: storedStructured || parseResearcherStructuredOutput(brief),
    provenance: baseProvenance("synthetic", {
      workItemId,
      freshness: "fresh",
      fallbackReason: reason || "deterministic_no_research",
    }),
    researchJob: null,
    artifact,
  };
}

/**
 * Resolve the one research result that is permitted to feed a planner job.
 * The function is synchronous because all custody and queue reads are local DB
 * operations and both current consumers are synchronous at their boundary.
 */
export function resolveResearchContextForWorkItem({
  workItemId,
  plannerJob = null,
  plannerJobId = null,
  researchSkipped = false,
  researchSkipReason = null,
  syntheticRouting = null,
} = {}, injectedDeps = {}) {
  const deps = { ...DEFAULT_DEPS, ...injectedDeps };
  const expectedWorkItemId = positiveInt(workItemId);
  const resolvedPlannerJob = plannerJob || deps.getJob(plannerJobId);
  if (!expectedWorkItemId || !resolvedPlannerJob
    || positiveInt(resolvedPlannerJob.work_item_id) !== expectedWorkItemId) {
    throw continuityFault("Research continuity requires an exact planner and work item identity");
  }
  if (researchSkipped) {
    return syntheticContext({
      workItemId: expectedWorkItemId,
      reason: researchSkipReason,
      routing: syntheticRouting,
    }, deps);
  }

  const ancestors = plannerAncestors(resolvedPlannerJob, deps);
  const researchJob = (deps.listJobsByWorkItem(expectedWorkItemId) || [])
    .filter((job) => acceptedResearchJob(job, expectedWorkItemId, ancestors))
    .sort((left, right) => positiveInt(right.id) - positiveInt(left.id))[0] || null;
  if (!researchJob) {
    return {
      brief: "",
      structuredData: null,
      provenance: baseProvenance("raw_fallback", {
        workItemId: expectedWorkItemId,
        freshness: "unavailable",
        fallbackReason: "accepted_research_unavailable",
      }),
      researchJob: null,
      artifact: null,
    };
  }

  let handoff;
  try {
    handoff = deps.getLatestCommittedAgentHandoffPacket({
      workItemId: expectedWorkItemId,
      jobId: researchJob.id,
    });
  } catch (error) {
    throw continuityFault(
      `Research packet custody failed for job #${researchJob.id}: ${error?.message || error}`,
      error,
    );
  }
  if (handoff) {
    const packet = handoff.packet;
    let structuredData;
    try {
      structuredData = researcherPacketToStructuredOutput(packet);
    } catch (error) {
      throw continuityFault(
        `Research packet projection failed for job #${researchJob.id}: ${error?.message || error}`,
        error,
      );
    }
    const profileMismatch = packet.profile === "researcher.report.v1";
    return {
      brief: deps.renderAgentHandoffCompatibilityOutput(packet),
      structuredData,
      provenance: baseProvenance("terminal_packet", {
        profile: packet.profile,
        workItemId: expectedWorkItemId,
        jobId: researchJob.id,
        attemptId: handoff.attempt_id,
        agentCallId: handoff.agent_call_id,
        packetDigest: handoff.packet_digest,
        freshness: "fresh",
        fallbackReason: profileMismatch ? "profile_mismatch_compat" : null,
      }),
      researchJob,
      artifact: null,
    };
  }

  const artifact = (deps.getArtifacts(researchJob.id, "response") || [])
    .sort((left, right) => positiveInt(right.id) - positiveInt(left.id))[0] || null;
  if (!artifact) {
    return {
      brief: "",
      structuredData: null,
      provenance: baseProvenance("raw_fallback", {
        workItemId: expectedWorkItemId,
        jobId: researchJob.id,
        freshness: "unavailable",
        fallbackReason: "packet_and_artifact_missing",
      }),
      researchJob,
      artifact: null,
    };
  }
  const brief = String(artifact.content_long || "");
  const structuredData = parseResearcherStructuredOutput(brief);
  return {
    brief,
    structuredData,
    provenance: baseProvenance(structuredData ? "json_artifact" : "raw_fallback", {
      workItemId: expectedWorkItemId,
      jobId: researchJob.id,
      attemptId: positiveInt(artifact.attempt_id),
      freshness: "partial",
      fallbackReason: structuredData ? "packet_missing" : "packet_missing_unstructured",
    }),
    researchJob,
    artifact,
  };
}

export function recordResearchContinuityObservation({
  plannerJob,
  attemptId = null,
  provenance,
  structuredData = null,
  droppedPathCount = 0,
} = {}, injectedDeps = {}) {
  if (!plannerJob || !provenance) return false;
  const deps = { ...DEFAULT_DEPS, ...injectedDeps };
  const count = (value) => Array.isArray(value) ? value.length : 0;
  return deps.recordObservation({
    work_item_id: plannerJob.work_item_id,
    job_id: plannerJob.id,
    attempt_id: attemptId,
    observation_type: "research.continuity",
    summary: `Resolved planner research from ${provenance.source}`,
    detail: {
      source: provenance.source,
      profile: provenance.profile,
      work_item_id: provenance.work_item_id,
      job_id: provenance.job_id,
      attempt_id: provenance.attempt_id,
      agent_call_id: provenance.agent_call_id,
      packet_digest: provenance.packet_digest,
      freshness: provenance.freshness,
      fallback_reason: provenance.fallback_reason,
      structured_counts: {
        key_files: count(structuredData?.key_files),
        related_files: count(structuredData?.related_files),
        key_symbols: count(structuredData?.key_symbols),
        priorities: count(structuredData?.planner_file_priorities),
        proof: count(structuredData?.proof),
        support: count(structuredData?.support),
        decoy: count(structuredData?.decoy),
      },
      dropped_path_count: Math.max(0, Number(droppedPathCount) || 0),
    },
  });
}
