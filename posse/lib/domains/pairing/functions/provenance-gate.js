// Exact-tip provenance reviews for a session trunk. An unknown commit on the
// session branch raises one review; its answer moves this session's
// provenance baseline (accept) or records the rejection. The scheduler's trunk
// poller applies answers at the start of each lap, and a closing host applies
// them before its final sync, when no poll runs.

import { TRUNK_HEAD_PATTERN } from "../../../catalog/session-sync.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import {
  createJob,
  forceUpdateJobStatus,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  setJobResult,
  updateSharedTrunkRuntimeStatus,
} from "../../queue/functions/index.js";
import { getLivePairingState, updatePairingEnrollment } from "./state.js";

const ACTIVE_SESSION_PHASES = Object.freeze(["active"]);

// The phases a host's session row can hold at its close's final sync: active
// for a close in progress, and leaving or restore_blocked when crash recovery
// reruns a close whose restore was interrupted or refused.
export const HOST_CLOSE_SESSION_PHASES = Object.freeze(["active", "leaving", "restore_blocked"]);

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function provenanceGateRows() {
  return getDb().prepare(`
    SELECT * FROM jobs
    WHERE job_type = 'human_input'
      AND status IN ('queued','leased','running','waiting_on_human','blocked','succeeded')
      AND CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.subtype') = 'shared_trunk_provenance'
      ELSE 0 END
  `).all();
}

// A provenance gate belongs to the session branch it was raised for; one left
// by an earlier session must never move this session's baseline.
function gateBelongsToSession(job, state, phases = ACTIVE_SESSION_PHASES) {
  const payload = parseJson(job.payload_json);
  return phases.includes(state?.phase) && Boolean(state.shared_branch && state.remote_session_id)
    && payload.branch === state.shared_branch
    && (!payload.remote || payload.remote === state.remote_name)
    && payload.session_id === state.remote_session_id;
}

const OPEN_PROVENANCE_GATE_STATUSES = Object.freeze(["queued", "leased", "running", "waiting_on_human", "blocked"]);

function retireProvenanceGate(job, reason, remoteOid = null) {
  if (!forceUpdateJobStatus(job.id, "canceled", { expectedStatuses: OPEN_PROVENANCE_GATE_STATUSES })) return false;
  setJobResult(job.id, { canceled: true, reason, remote_oid: remoteOid });
  return true;
}

export function retireOpenProvenanceGates(state, reason, remoteOid = null) {
  if (!state) return;
  for (const job of provenanceGateRows()) {
    if (OPEN_PROVENANCE_GATE_STATUSES.includes(job.status) && gateBelongsToSession(job, state)) {
      retireProvenanceGate(job, reason, remoteOid);
    }
  }
}

/**
 * Apply the first answered, unapplied review of the live session. `phases`
 * names the session phases it may apply in (the poller: active only); the
 * session keeps its phase.
 */
export function applyProvenanceGateDecision({ phases = ACTIVE_SESSION_PHASES } = {}) {
  const state = getLivePairingState();
  if (!state) return null;
  const gate = provenanceGateRows().find((job) => {
    if (job.status !== "succeeded" || !gateBelongsToSession(job, state, phases)) return false;
    return parseJson(job.result_json)?.provenance_applied !== true;
  });
  if (!gate) return null;
  const payload = parseJson(gate.payload_json);
  const result = parseJson(gate.result_json);
  const observedOid = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK)?.remote_sha;
  if ((observedOid && observedOid !== payload.remote_oid)
    || (observedOid === payload.remote_oid && state.baseline_oid === observedOid)) {
    getDb().prepare("UPDATE jobs SET result_json=? WHERE id=?").run(JSON.stringify({
      ...result,
      provenance_applied: true,
      provenance_superseded: true,
    }), gate.id);
    return { gateId: gate.id, superseded: true };
  }
  const gateContract = getDb().prepare(
    "SELECT resolution_action FROM human_gates WHERE gate_job_id = ?"
  ).get(gate.id);
  const answer = String(
    result.answer
    || result.response
    || result.answers?.[0]?.answer
    || gateContract?.resolution_action
    || ""
  ).trim().toLowerCase();
  const accepted = answer.startsWith("accept") || answer === "yes" || answer === "approve";
  if (accepted && TRUNK_HEAD_PATTERN.test(String(payload.remote_oid || ""))) {
    updatePairingEnrollment(state.id, { baselineOid: payload.remote_oid, phase: state.phase });
  } else {
    updateSharedTrunkRuntimeStatus({
      provenance_gate_rejected: true,
      provenance_gate_rejected_oid: payload.remote_oid || null,
    });
  }
  getDb().prepare("UPDATE jobs SET result_json=? WHERE id=?").run(JSON.stringify({
    ...result,
    provenance_applied: true,
    provenance_accepted: accepted,
  }), gate.id);
  return { gateId: gate.id, accepted };
}

/**
 * The open review for the tip a provenance-blocked sync fetched: the existing
 * one, or a new one after retiring reviews of an earlier tip. Null when that
 * exact tip was already rejected.
 */
export function ensureProvenanceGate(result, { phases = ACTIVE_SESSION_PHASES } = {}) {
  const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK) || {};
  const remoteOid = result?.remoteSha || result?.newSha || status.remote_sha || null;
  if (status.provenance_gate_rejected === true
    && status.provenance_gate_rejected_oid === remoteOid) return null;
  if (status.provenance_gate_rejected === true) {
    updateSharedTrunkRuntimeStatus({
      provenance_gate_rejected: false,
      provenance_gate_rejected_oid: null,
      provenance_gate_job_id: null,
    });
  }
  const live = getLivePairingState();
  for (const job of provenanceGateRows()) {
    if (!OPEN_PROVENANCE_GATE_STATUSES.includes(job.status) || !gateBelongsToSession(job, live, phases)) continue;
    if (parseJson(job.payload_json).remote_oid === remoteOid) return job;
    // The exact tip named by a pending review has moved. Retire that review
    // before creating one for the tip actually fetched this cycle.
    retireProvenanceGate(job, "remote_tip_superseded", remoteOid);
  }
  const commits = (result?.provenance?.commits || []).slice(0, 32);
  const gate = createJob({
    work_item_id: null,
    job_type: "human_input",
    title: "Review unknown shared-trunk commits",
    priority: "urgent",
    max_attempts: 1,
    payload_json: {
      subtype: "shared_trunk_provenance",
      review_type: "shared_trunk_provenance",
      question_kind: "shared_trunk_provenance",
      questions: ["Unknown commits were found on the session trunk. Accept this exact remote tip, or reject and inspect it manually?"],
      choices: ["accept", "reject"],
      remote_oid: remoteOid,
      branch: live?.shared_branch || null,
      remote: live?.remote_name || null,
      session_id: live?.remote_session_id || null,
      commits,
    },
  });
  updateSharedTrunkRuntimeStatus({ provenance_gate_job_id: gate.id });
  return gate;
}
