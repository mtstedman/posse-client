import { BRIDGE_COMMANDS } from "../../../catalog/bridge.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getLivePairingState } from "../../pairing/functions/state.js";
import { getWorkItem } from "../../queue/functions/index.js";

const PILOT_READ_COMMANDS = new Set([
  BRIDGE_COMMANDS.WORK_ITEM_GET,
  BRIDGE_COMMANDS.JOBS_LIST,
]);

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Remote authenticates and reconstructs the sponsor grant; the target Bridge
 * independently checks that its local WI really maps to the canonical Session
 * WI. A sponsor-local integer is never treated as the Session identity. */
export function authorizeRelaySponsorship(frame, name, args, context = {}) {
  const grant = frame?.sponsorship;
  if (grant == null) return { ok: true };
  if (context.actor !== "bridge-relay" || !PILOT_READ_COMMANDS.has(name)) {
    return { ok: false, reason: "sponsorship_denied" };
  }
  const localWorkItemId = positiveInteger(grant.sponsor_work_item_id);
  if (!localWorkItemId || positiveInteger(args?.work_item_id) !== localWorkItemId
      || !getWorkItem(localWorkItemId)) {
    return { ok: false, reason: "sponsorship_work_item_mismatch" };
  }
  const state = getLivePairingState();
  if (!state || state.phase !== "active"
      || grant.session_id !== state.remote_session_id
      || grant.sponsor_instance_id !== state.instance_id
      || frame.instance_id !== state.instance_id
      || context.bridgeInstanceId !== state.instance_id) {
    return { ok: false, reason: "sponsorship_session_mismatch" };
  }
  let canonicalWorkItemId = `${state.instance_id}:${localWorkItemId}`;
  const delegated = getDb().prepare(`
    SELECT DISTINCT originator_instance_id, origin_work_item_id
    FROM work_item_delegations
    WHERE session_id = ? AND local_work_item_id = ?
    LIMIT 2
  `).all(state.remote_session_id, localWorkItemId);
  if (delegated.length > 1) {
    return { ok: false, reason: "sponsorship_work_item_ambiguous" };
  }
  if (delegated.length === 1) {
    canonicalWorkItemId = `${delegated[0].originator_instance_id}:${delegated[0].origin_work_item_id}`;
  }
  if (grant.work_item_id !== canonicalWorkItemId
      || typeof grant.grant_id !== "string" || !grant.grant_id
      || !Number.isSafeInteger(grant.revision) || grant.revision < 1
      || typeof grant.jti !== "string" || !grant.jti
      || typeof grant.pilot_instance_id !== "string" || !grant.pilot_instance_id) {
    return { ok: false, reason: "sponsorship_grant_mismatch" };
  }
  return { ok: true, pilotInstanceId: grant.pilot_instance_id,
    canonicalWorkItemId, localWorkItemId };
}
