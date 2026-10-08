import { randomUUID } from "node:crypto";

import { getDb } from "../../../shared/storage/functions/index.js";
import { SESSION_PUBLISH_MODES } from "../../../catalog/session-sync.js";
import { runImmediateTransaction } from "../../queue/functions/common.js";
import { readSessionLink } from "./session-link.js";

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

/** Branch and session remote of every ended session whose branch is not live again. */
export function listEndedPairingTargets(db = getDb()) {
  return db.prepare(`
    SELECT DISTINCT shared_branch AS branch, remote_name AS remote FROM pairing_sessions
    WHERE phase = 'left'
      AND shared_branch IS NOT NULL AND shared_branch <> ''
      AND shared_branch NOT IN (
        SELECT shared_branch FROM pairing_sessions
        WHERE phase IN (${LIVE_PHASES_SQL}) AND shared_branch IS NOT NULL
      )
    ORDER BY shared_branch, remote_name
  `).all();
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
      const error = new Error(`This clone is already paired as ${live.role} (${live.phase}). Run \`posse session leave\` first.`);
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
  remoteUrl = null,
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
  submissionApprovalEnabled = null,
  submissionPolicyRevision = null,
  teamPublicationMode = null,
  teamPublicationRevision = null,
} = {}, db = getDb()) {
  return runImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE pairing_sessions
      SET remote_session_id = COALESCE(?, remote_session_id),
          relay_token = COALESCE(?, relay_token),
          added_remote_name = COALESCE(?, added_remote_name),
          added_remote_url = COALESCE(?, added_remote_url),
          remote_name = COALESCE(?, remote_name),
          remote_url = COALESCE(?, remote_url),
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
          submission_approval_enabled = COALESCE(?, submission_approval_enabled),
          submission_approval_revision = COALESCE(?, submission_approval_revision),
          team_publication_mode = COALESCE(?, team_publication_mode),
          team_publication_revision = COALESCE(?, team_publication_revision),
          phase = ?,
          last_error = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(
      remoteSessionId, relayToken, addedRemoteName, addedRemoteUrl, remoteName, remoteUrl,
      instanceId, scopeSet == null ? null : JSON.stringify(scopeSet), computePolicy,
      integrationPolicy, enrollmentOpen == null ? null : Number(Boolean(enrollmentOpen)),
      baselineOid, originRemoteName, originRemoteUrl, temporaryRepository, closeAction,
      credentialDirectory,
      submissionApprovalEnabled == null ? null : Number(Boolean(submissionApprovalEnabled)),
      submissionPolicyRevision,
      teamPublicationMode, teamPublicationRevision,
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

const SESSION_PUBLISH_MODE_VALUES = new Set(Object.values(SESSION_PUBLISH_MODES));
const UNSET = Symbol("unset");

/**
 * In-session merge/deploy settings and results. Touches only those columns:
 * `updated_at` is the session owner's heartbeat, so a setting changed from
 * another terminal must not make a dead owner look alive. A value left
 * undefined keeps the column; null clears it.
 */
export function updateSessionPublishSettings(id, {
  mergeMode = UNSET,
  deployMode = UNSET,
  autoPausedReason = UNSET,
  lastMergeOid = UNSET,
  lastDeployOid = UNSET,
} = {}, db = getDb()) {
  const updates = [];
  const values = [];
  for (const [column, value] of [["merge_mode", mergeMode], ["deploy_mode", deployMode]]) {
    if (value === UNSET || value === undefined) continue;
    if (!SESSION_PUBLISH_MODE_VALUES.has(value)) {
      throw Object.assign(new Error(`Unknown session ${column.replace("_", " ")}: ${value}`), { code: "session_publish_mode_invalid" });
    }
    updates.push(`${column} = ?`);
    values.push(value);
  }
  for (const [column, value] of [
    ["auto_paused_reason", autoPausedReason], ["last_merge_oid", lastMergeOid], ["last_deploy_oid", lastDeployOid],
  ]) {
    if (value === UNSET || value === undefined) continue;
    updates.push(`${column} = ?`);
    values.push(value === null ? null : String(value));
  }
  if (updates.length > 0) {
    db.prepare(`UPDATE pairing_sessions SET ${updates.join(", ")} WHERE id = ?`).run(...values, String(id));
  }
  return getPairingState(id, db);
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

/**
 * Take heartbeat ownership back from `fromPid`, but only while it still owns
 * the session: a scheduler that adopted in between is never displaced.
 * @returns {boolean} true when this call adopted the session.
 */
export function readoptPairingProcess(id, { fromPid = null, toPid = process.pid } = {}, db = getDb()) {
  const pid = Number(toPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError("pairing process pid must be a positive integer");
  }
  const expected = fromPid == null ? null : Number(fromPid);
  const result = db.prepare(`
    UPDATE pairing_sessions
    SET process_pid = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND phase = 'active' AND process_pid IS ?
  `).run(pid, String(id), expected);
  return result.changes > 0;
}

export function pairingOwnerProcessIsAlive(
  state,
  kill = process.kill.bind(process),
  nowMs = Date.now(),
  readLink = readSessionLink,
) {
  const pid = Number(state?.process_pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const lastHeartbeatMs = Date.parse(String(state?.updated_at || ""));
  if (Number.isFinite(lastHeartbeatMs) && nowMs - lastHeartbeatMs > PAIRING_OWNER_STALE_MS
    && !ownerAttemptedRelayRecently(state, pid, nowMs, readLink)) {
    // A reused PID can belong to an unrelated process. The durable monitor
    // heartbeat makes the PID evidence time-bounded without platform-specific
    // process-start probes. A relay outage is the exception: the owner keeps
    // the session and retries while the relay is unreachable, stamping each
    // attempt on the session link, but the heartbeat only advances on a
    // *successful* beat, so it goes stale while the process is healthy. A
    // recent attempt from this same pid is the outage signature, so fall
    // through to the liveness probe rather than reading the stale heartbeat
    // as a crash. The kill() probe below is still the final arbiter: a pid
    // that is actually gone stays dead even with a fresh link.
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

// ownerAttemptedRelayRecently reports that this session's owner recorded a
// relay heartbeat attempt within the stale window from the same pid. Only this
// session's own console or scheduler monitor writes that link, so a reused or
// unrelated pid never forges it, and a crashed owner stops stamping it and
// lets it age out. A link for another session, a different owner pid, a read
// failure, or an id-less state all decline, keeping the stale-is-dead default.
function ownerAttemptedRelayRecently(state, pid, nowMs, readLink) {
  const stateId = state?.id;
  if (!stateId) return false;
  let link;
  try {
    link = readLink({ stateId });
  } catch {
    return false;
  }
  if (!link) return false;
  const linkPid = Number(link.owner_pid);
  if (Number.isSafeInteger(linkPid) && linkPid > 0 && linkPid !== pid) return false;
  const attemptMs = Date.parse(String(link.last_attempt_at || ""));
  return Number.isFinite(attemptMs) && nowMs - attemptMs <= PAIRING_OWNER_STALE_MS;
}
