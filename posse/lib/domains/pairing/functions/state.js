import { randomUUID } from "node:crypto";

import { getDb } from "../../../shared/storage/functions/index.js";
import { runImmediateTransaction } from "../../queue/functions/common.js";

const LIVE_PHASES_SQL = "'enrolling','pending','active','leaving','restore_blocked'";
const PAIRING_OWNER_STALE_MS = 120_000;

function parseState(row) {
  if (!row) return null;
  let originalSettings = {};
  let scopeSet = {};
  try {
    originalSettings = JSON.parse(row.original_settings_json || "{}");
  } catch {
    originalSettings = {};
  }
  try {
    scopeSet = JSON.parse(row.scope_set_json || "{}");
  } catch {
    scopeSet = {};
  }
  return {
    ...row,
    originalSettings,
    scopeSet,
  };
}

export function getLivePairingState(db = getDb()) {
  return parseState(db.prepare(`
    SELECT * FROM pairing_sessions
    WHERE phase IN (${LIVE_PHASES_SQL})
    ORDER BY created_at DESC
    LIMIT 1
  `).get());
}

export function getPairingState(id, db = getDb()) {
  return parseState(db.prepare("SELECT * FROM pairing_sessions WHERE id = ?").get(String(id)));
}

export function createPairingState({
  role,
  remoteName,
  remoteUrl,
  sharedBranch,
  originalBranch,
  originalHead,
  originalSettings,
  processPid = process.pid,
  instanceId = null,
  originalSshCommand = null,
}, db = getDb()) {
  return runImmediateTransaction(db, () => {
    const live = getLivePairingState(db);
    if (live) {
      const error = new Error(`This clone is already paired as ${live.role} (${live.phase}). Run \`posse pair leave\` first.`);
      error.code = "pairing_already_active";
      throw error;
    }
    const id = randomUUID();
    db.prepare(`
      INSERT INTO pairing_sessions (
        id, role, remote_name, remote_url, shared_branch,
        original_branch, original_head, original_settings_json,
        phase, process_pid, instance_id, original_ssh_command
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enrolling', ?, ?, ?)
    `).run(
      id,
      role,
      remoteName,
      remoteUrl,
      sharedBranch,
      originalBranch,
      originalHead,
      JSON.stringify(originalSettings || {}),
      processPid,
      instanceId,
      originalSshCommand,
    );
    return getPairingState(id, db);
  });
}

export function updatePairingEnrollment(id, {
  remoteSessionId = null,
  relayToken = null,
  addedRemoteName = null,
  addedRemoteUrl = null,
  remoteName = null,
  phase = "active",
  instanceId = null,
  scopeSet = null,
  computePolicy = null,
  integrationPolicy = null,
  enrollmentOpen = null,
  baselineOid = null,
  originRemoteName = null,
  originRemoteUrl = null,
  temporaryRepository = null,
  closeAction = null,
  credentialDirectory = null,
} = {}, db = getDb()) {
  return runImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE pairing_sessions
      SET remote_session_id = COALESCE(?, remote_session_id),
          relay_token = COALESCE(?, relay_token),
          added_remote_name = COALESCE(?, added_remote_name),
          added_remote_url = COALESCE(?, added_remote_url),
          remote_name = COALESCE(?, remote_name),
          instance_id = COALESCE(?, instance_id),
          scope_set_json = COALESCE(?, scope_set_json),
          compute_policy = COALESCE(?, compute_policy),
          integration_policy = COALESCE(?, integration_policy),
          enrollment_open = COALESCE(?, enrollment_open),
          baseline_oid = COALESCE(?, baseline_oid),
          origin_remote_name = COALESCE(?, origin_remote_name),
          origin_remote_url = COALESCE(?, origin_remote_url),
          temporary_repository = COALESCE(?, temporary_repository),
          close_action = COALESCE(?, close_action),
          credential_directory = COALESCE(?, credential_directory),
          phase = ?,
          last_error = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(
      remoteSessionId, relayToken, addedRemoteName, addedRemoteUrl, remoteName,
      instanceId, scopeSet == null ? null : JSON.stringify(scopeSet), computePolicy,
      integrationPolicy, enrollmentOpen == null ? null : Number(Boolean(enrollmentOpen)),
      baselineOid, originRemoteName, originRemoteUrl, temporaryRepository, closeAction,
      credentialDirectory,
      phase, String(id),
    );
    return getPairingState(id, db);
  });
}

export function markPairingPhase(id, phase, lastError = null, db = getDb()) {
  return runImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE pairing_sessions
      SET phase = ?, last_error = ?,
          relay_token = CASE WHEN ? = 'left' THEN NULL ELSE relay_token END,
          process_pid = CASE WHEN ? = 'left' THEN NULL ELSE process_pid END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(phase, lastError, phase, phase, String(id));
    return getPairingState(id, db);
  });
}

export function pairingProcessShouldStop(id, db = getDb()) {
  const row = db.prepare("SELECT phase FROM pairing_sessions WHERE id = ?").get(String(id));
  return !row || row.phase !== "active";
}

export function touchPairingState(id, db = getDb(), phases = ["active"]) {
  const allowed = new Set(["enrolling", "pending", "active", "leaving", "restore_blocked"]);
  const normalizedPhases = phases.map(String).filter((phase) => allowed.has(phase));
  if (normalizedPhases.length === 0) return getPairingState(id, db);
  const placeholders = normalizedPhases.map(() => "?").join(",");
  db.prepare(`
    UPDATE pairing_sessions
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND phase IN (${placeholders})
  `).run(String(id), ...normalizedPhases);
  return getPairingState(id, db);
}

export function adoptPairingProcess(id, processPid = process.pid, db = getDb()) {
  const pid = Number(processPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("pairing process pid must be a positive integer");
  }
  db.prepare(`
    UPDATE pairing_sessions
    SET process_pid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND phase = 'active'
  `).run(pid, String(id));
  return getPairingState(id, db);
}

export function pairingOwnerProcessIsAlive(
  state,
  kill = process.kill.bind(process),
  nowMs = Date.now(),
) {
  const pid = Number(state?.process_pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const lastHeartbeatMs = Date.parse(String(state?.updated_at || ""));
  if (Number.isFinite(lastHeartbeatMs) && nowMs - lastHeartbeatMs > PAIRING_OWNER_STALE_MS) {
    // A reused PID can belong to an unrelated process. The durable monitor
    // heartbeat makes the PID evidence time-bounded without platform-specific
    // process-start probes.
    return false;
  }
  if (pid === process.pid) return true;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    // EPERM and unknown platform errors do not prove the recorded owner died.
    return true;
  }
}
