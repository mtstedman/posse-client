import { AGENT_HANDOFF_PROFILES } from "../../../catalog/handoff.js";
import crypto from "node:crypto";
import { getDb } from "../../../shared/storage/functions/index.js";
import { AGENT_HANDOFF_PACKET_TABLE as TABLE, agentHandoffSchema } from "../classes/AgentHandoffSchema.js";
import { positiveInt } from "./helpers/rejection-store.js";
import { parseStoredAgentHandoffPacket } from "./helpers/packet-storage.js";

export function handoffRow(agentCallId, db = getDb()) {
  const id = positiveInt(agentCallId);
  if (!id) return null;
  return agentHandoffSchema.ensure(db).prepare(`SELECT * FROM ${TABLE} WHERE agent_call_id = ?`).get(id) || null;
}

export function getAgentHandoffRecord(agentCallId, { db = getDb() } = {}) {
  const row = handoffRow(agentCallId, db);
  if (!row) return null;
  return { ...row, packet: parseStoredAgentHandoffPacket(row.materialized_packet_json) };
}

/**
 * The structured completion (status, blocker, remaining_work) an attempt's
 * dev/fix/artificer call committed. Post-execution otherwise sees only the
 * compatibility DEV/ARTIFICER RESULT block, whose notes are cut to 30 words.
 * Null when the attempt committed no compact completion packet.
 */
export function getCommittedAttemptCompletion({ jobId, attemptId } = {}, { db = getDb() } = {}) {
  const expectedJobId = positiveInt(jobId);
  const expectedAttemptId = positiveInt(attemptId);
  if (!expectedJobId || !expectedAttemptId) return null;
  const row = agentHandoffSchema.ensure(db).prepare(`
    SELECT materialized_packet_json
    FROM ${TABLE}
    WHERE job_id = ? AND attempt_id = ? AND status = 'committed'
      AND profile IN ('dev.result.v1', 'artificer.result.v1')
    ORDER BY agent_call_id DESC
    LIMIT 1
  `).get(expectedJobId, expectedAttemptId);
  if (!row) return null;
  try {
    const completion = JSON.parse(row.materialized_packet_json)?.completion;
    return completion && typeof completion === "object" && !Array.isArray(completion) ? completion : null;
  } catch {
    return null;
  }
}

function handoffCustodyFailure(message) {
  const error = new Error(message);
  error.code = "AGENT_HANDOFF_CUSTODY_INVALID";
  throw error;
}

/**
 * Return the terminal packet attached to the newest exact research agent call.
 * A present packet is a custody boundary: invalid, non-committed, or mismatched
 * rows fault instead of becoming permission to parse a compatibility artifact.
 */
export function getLatestCommittedAgentHandoffPacket({
  workItemId,
  jobId,
  attemptId = null,
} = {}, { db = getDb() } = {}) {
  const expectedWorkItemId = positiveInt(workItemId);
  const expectedJobId = positiveInt(jobId);
  const expectedAttemptId = attemptId == null ? null : positiveInt(attemptId);
  if (!expectedWorkItemId || !expectedJobId || (attemptId != null && !expectedAttemptId)) {
    handoffCustodyFailure("Exact work item and job identities are required to read a terminal handoff");
  }
  const database = agentHandoffSchema.ensure(db);
  const params = [expectedWorkItemId, expectedJobId];
  const attemptClause = expectedAttemptId == null ? "" : " AND ac.attempt_id = ?";
  if (expectedAttemptId != null) params.push(expectedAttemptId);
  const row = database.prepare(`
    SELECT p.*,
      ac.work_item_id AS call_work_item_id,
      ac.job_id AS call_job_id,
      ac.attempt_id AS call_attempt_id,
      ac.role AS call_role
    FROM agent_calls ac
    JOIN ${TABLE} p ON p.agent_call_id = ac.id
    WHERE ac.work_item_id = ?
      AND ac.job_id = ?
      AND ac.parent_agent_call_id IS NULL
      AND ac.role = 'researcher'
      ${attemptClause}
    ORDER BY ac.id DESC
    LIMIT 1
  `).get(...params);
  if (!row) return null;
  if (row.status !== "committed") {
    handoffCustodyFailure(`Newest terminal handoff for research job #${expectedJobId} is ${row.status}`);
  }
  if (!row.committed_at) {
    handoffCustodyFailure(`Committed terminal handoff for research job #${expectedJobId} has no commit timestamp`);
  }
  const digest = crypto.createHash("sha256").update(row.materialized_packet_json).digest("hex");
  if (digest !== row.packet_digest) {
    handoffCustodyFailure(`Terminal handoff digest verification failed for research job #${expectedJobId}`);
  }
  let packet;
  try {
    packet = parseStoredAgentHandoffPacket(row.materialized_packet_json);
  } catch (error) {
    handoffCustodyFailure(`Terminal handoff packet could not be decoded for research job #${expectedJobId}: ${error?.message || error}`);
  }

  const identities = [
    ["work item", expectedWorkItemId, row.call_work_item_id, row.work_item_id, packet.work_item_id],
    ["job", expectedJobId, row.call_job_id, row.job_id, packet.job_id],
    ["agent call", row.agent_call_id, packet.agent_call_id],
  ];
  const resolvedAttemptId = expectedAttemptId || positiveInt(row.call_attempt_id);
  if (resolvedAttemptId) {
    identities.push([
      "attempt",
      resolvedAttemptId,
      row.call_attempt_id,
      row.attempt_id,
      packet.attempt_id,
    ]);
  }
  for (const [label, expected, ...values] of identities) {
    if (values.some((value) => positiveInt(value) !== positiveInt(expected))) {
      handoffCustodyFailure(`Terminal handoff ${label} identity mismatch for research job #${expectedJobId}`);
    }
  }
  if (row.call_role !== "researcher" || row.role !== row.call_role || packet.role !== row.role) {
    handoffCustodyFailure(`Terminal handoff role identity mismatch for research job #${expectedJobId}`);
  }
  if (packet.profile !== row.profile
    || ![AGENT_HANDOFF_PROFILES.RESEARCHER_PIPELINE, AGENT_HANDOFF_PROFILES.RESEARCHER_REPORT].includes(packet.profile)) {
    handoffCustodyFailure(`Terminal handoff profile identity mismatch for research job #${expectedJobId}`);
  }
  if (packet.outcome !== row.outcome) {
    handoffCustodyFailure(`Terminal handoff outcome identity mismatch for research job #${expectedJobId}`);
  }
  return {
    packet,
    packet_digest: digest,
    agent_call_id: positiveInt(row.agent_call_id),
    work_item_id: expectedWorkItemId,
    job_id: expectedJobId,
    attempt_id: resolvedAttemptId,
    profile: packet.profile,
    outcome: packet.outcome,
  };
}
