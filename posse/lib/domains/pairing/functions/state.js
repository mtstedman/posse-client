import { randomUUID } from "node:crypto";

import { getDb } from "../../../shared/storage/functions/index.js";
import { runImmediateTransaction } from "../../queue/functions/common.js";

const LIVE_PHASES_SQL = "'enrolling','active','leaving','restore_blocked'";
const PAIRING_OWNER_STALE_MS = 120_000;

function parseState(row) {
  if (!row) return null;
  let originalSettings = {};
  try {
    originalSettings = JSON.parse(row.original_settings_json || "{}");
  } catch {
    originalSettings = {};
  }
  return {
    ...row,
    originalSettings,
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
        phase, process_pid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'enrolling', ?)
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
} = {}, db = getDb()) {
  return runImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE pairing_sessions
      SET remote_session_id = COALESCE(?, remote_session_id),
          relay_token = COALESCE(?, relay_token),
          added_remote_name = COALESCE(?, added_remote_name),
          added_remote_url = COALESCE(?, added_remote_url),
          remote_name = COALESCE(?, remote_name),
          phase = ?,
          last_error = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(remoteSessionId, relayToken, addedRemoteName, addedRemoteUrl, remoteName, phase, String(id));
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

export function touchPairingState(id, db = getDb()) {
  db.prepare(`
    UPDATE pairing_sessions
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND phase = 'active'
  `).run(String(id));
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
