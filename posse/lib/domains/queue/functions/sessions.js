// DB primitives for work-item-scoped provider session recycling.
//
// Runtime integration is intentionally separate. This layer only owns durable
// lane locks, handle lifecycle, leases, and savings telemetry.

import crypto from "crypto";
import { getDb } from "../../../shared/storage/functions/index.js";
import { deriveSessionKey } from "../../session/functions/keys.js";
import { now, runImmediateTransaction } from "./common.js";
import { getSetting } from "./settings.js";
import { flushEventsNow, logEvent } from "./events.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

function normalizeProvider(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSkillKey(value) {
  return String(value || "");
}

function isSqliteConstraintError(err) {
  const code = String(err?.code || "");
  return code.startsWith("SQLITE_CONSTRAINT");
}

function readPositiveIntSetting(key, fallback) {
  try {
    const parsed = Number.parseInt(String(getSetting(key) || ""), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  } catch {
    // Settings may be unavailable during early imports/tests.
  }
  return fallback;
}

export function sessionLeaseTtlSec() {
  return readPositiveIntSetting("posse_session_lease_ttl", 300);
}

export function getActiveSessionLane({ workItemId, lane, skillKey = "" } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM session_lanes
    WHERE work_item_id = ? AND lane = ? AND skill_key = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(Number(workItemId), String(lane || ""), normalizeSkillKey(skillKey)) || null;
}

export function ensureSessionLane({
  workItemId,
  lane,
  provider,
  skillKey = "",
  lockReason = "session_recycle",
} = {}) {
  const db = getDb();
  const providerName = normalizeProvider(provider);
  const normalizedSkillKey = normalizeSkillKey(skillKey);
  if (!Number.isFinite(Number(workItemId)) || !lane || !providerName) {
    throw new Error("ensureSessionLane requires workItemId, lane, and provider");
  }

  const execute = () => {
    const existing = getActiveSessionLane({ workItemId, lane, skillKey: normalizedSkillKey });
    if (existing) {
      return {
        lane: existing,
        created: false,
        providerLocked: existing.provider !== providerName,
        lockedProvider: existing.provider,
      };
    }

    const ts = now();
    let created;
    try {
      const info = db.prepare(`
        INSERT INTO session_lanes (
          work_item_id, lane, provider, skill_key, status,
          reset_generation, lock_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)
      `).run(Number(workItemId), String(lane), providerName, normalizedSkillKey, lockReason, ts, ts);
      created = db.prepare(`SELECT * FROM session_lanes WHERE id = ?`).get(info.lastInsertRowid);
    } catch (err) {
      const raced = isSqliteConstraintError(err)
        ? getActiveSessionLane({ workItemId, lane, skillKey: normalizedSkillKey })
        : null;
      if (!raced) throw err;
      return {
        lane: raced,
        created: false,
        providerLocked: raced.provider !== providerName,
        lockedProvider: raced.provider,
      };
    }
    logEvent({
      work_item_id: Number(workItemId),
      event_type: EVENT_TYPES.SESSION_LANE_LOCKED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Locked ${lane} session lane to ${providerName}`,
      event_json: JSON.stringify({ lane, provider: providerName, skill_key: normalizedSkillKey, lock_reason: lockReason }),
    });
    return {
      lane: created,
      created: true,
      providerLocked: false,
      lockedProvider: providerName,
    };
  };

  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function invalidateSessionLane(laneId, reason = "invalidated", { status = "invalidated" } = {}) {
  const db = getDb();
  const ts = now();
  const lane = db.prepare(`SELECT * FROM session_lanes WHERE id = ?`).get(Number(laneId));
  const result = db.prepare(`
    UPDATE session_lanes
    SET status = ?, reason = ?, invalidated_at = ?, updated_at = ?,
        reset_generation = reset_generation + 1
    WHERE id = ? AND status = 'active'
  `).run(status, reason, ts, ts, Number(laneId));

  if (result.changes > 0) {
    db.prepare(`
      UPDATE job_sessions
      SET status = ?, reason = ?, leased_by = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_used_at = ?
      WHERE lane_id = ? AND status = 'active'
    `).run(status, reason, ts, Number(laneId));
    if (lane) {
      logEvent({
        work_item_id: lane.work_item_id,
        event_type: EVENT_TYPES.SESSION_INVALIDATED,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Session lane ${lane.lane} ${status}: ${reason}`,
        event_json: JSON.stringify({
          lane_id: lane.id,
          lane: lane.lane,
          provider: lane.provider,
          skill_key: lane.skill_key || "",
          reason,
          status,
        }),
      });
      flushEventsNow();
    }
  }
  return result.changes;
}

export function invalidateSessionLanesForWorkItem(workItemId, reason = "work_item_reset", { status = "invalidated" } = {}) {
  const db = getDb();
  const lanes = db.prepare(`
    SELECT id FROM session_lanes
    WHERE work_item_id = ? AND status = 'active'
  `).all(Number(workItemId));
  let count = 0;
  for (const lane of lanes) count += invalidateSessionLane(lane.id, reason, { status });
  return count;
}

export function getActiveSessionForLane(laneId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM job_sessions
    WHERE lane_id = ? AND status = 'active'
    ORDER BY last_used_at DESC, id DESC
    LIMIT 1
  `).get(Number(laneId)) || null;
}

export function recordInitialSessionHandle({
  laneId,
  handle,
  parentJobId = null,
  expiresAt = null,
  lastAgentCallId = null,
} = {}) {
  const db = getDb();
  if (!Number.isFinite(Number(laneId)) || !handle) {
    throw new Error("recordInitialSessionHandle requires laneId and handle");
  }
  const lane = db.prepare(`SELECT * FROM session_lanes WHERE id = ?`).get(Number(laneId));
  if (!lane || lane.status !== "active") return null;

  const execute = () => {
    const existing = getActiveSessionForLane(lane.id);
    if (existing) return existing;
    const ts = now();
    try {
      const info = db.prepare(`
        INSERT INTO job_sessions (
          lane_id, work_item_id, lane, provider, skill_key, handle,
          parent_job_id, hop_count, status, created_at, last_used_at,
          expires_at, last_agent_call_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)
      `).run(
        lane.id,
        lane.work_item_id,
        lane.lane,
        lane.provider,
        lane.skill_key || "",
        String(handle),
        parentJobId == null ? null : Number(parentJobId),
        ts,
        ts,
        expiresAt || null,
        lastAgentCallId == null ? null : Number(lastAgentCallId),
      );
      return db.prepare(`SELECT * FROM job_sessions WHERE id = ?`).get(info.lastInsertRowid);
    } catch (err) {
      const raced = isSqliteConstraintError(err) ? getActiveSessionForLane(lane.id) : null;
      if (!raced) throw err;
      return raced;
    }
  };
  return db.inTransaction ? execute() : runImmediateTransaction(db, execute);
}

export function acquireSessionHandle({
  laneId,
  jobId,
  leaseTtlSec = sessionLeaseTtlSec(),
} = {}) {
  const db = getDb();
  const session = getActiveSessionForLane(laneId);
  if (!session) return null;

  const ts = now();
  if (session.expires_at && String(session.expires_at) <= ts) {
    markSessionExpired(session.id, "provider_ttl_elapsed");
    return null;
  }

  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(Date.now() + Math.max(1, Number(leaseTtlSec || 300)) * 1000).toISOString();
  const result = db.prepare(`
    UPDATE job_sessions
    SET leased_by = ?, lease_token = ?, lease_expires_at = ?, last_used_at = ?
    WHERE id = ? AND status = 'active'
      AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      AND (expires_at IS NULL OR expires_at > ?)
  `).run(Number(jobId), leaseToken, leaseExpiresAt, ts, session.id, ts, ts);

  if (result.changes === 0) return null;
  const leased = db.prepare(`SELECT * FROM job_sessions WHERE id = ?`).get(session.id);
  logEvent({
    work_item_id: leased.work_item_id,
    job_id: Number(jobId),
    event_type: EVENT_TYPES.SESSION_ACQUIRED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: `Acquired ${leased.lane} session hop ${leased.hop_count}`,
    event_json: JSON.stringify({ session_id: leased.id, lane_id: leased.lane_id, provider: leased.provider, hop_count: leased.hop_count }),
  });
  return { ...leased, leaseToken };
}

export function releaseSessionHandle(sessionId, leaseToken) {
  const db = getDb();
  return db.prepare(`
    UPDATE job_sessions
    SET leased_by = NULL, lease_token = NULL, lease_expires_at = NULL,
        last_used_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'active'
  `).run(now(), Number(sessionId), String(leaseToken || "")).changes;
}

export function renewSessionHandleLease(sessionId, leaseToken, {
  jobId = null,
  leaseTtlSec = sessionLeaseTtlSec(),
} = {}) {
  const db = getDb();
  const ts = now();
  const leaseExpiresAt = new Date(Date.now() + Math.max(1, Number(leaseTtlSec || 300)) * 1000).toISOString();
  const params = [
    leaseExpiresAt,
    ts,
    Number(sessionId),
    String(leaseToken || ""),
  ];
  const jobClause = jobId == null ? "" : " AND leased_by = ?";
  if (jobId != null) params.push(Number(jobId));
  const result = db.prepare(`
    UPDATE job_sessions
    SET lease_expires_at = ?, last_used_at = ?
    WHERE id = ? AND lease_token = ? AND status = 'active'${jobClause}
  `).run(...params);
  return result.changes > 0;
}

export function advanceSessionHandle({
  sessionId,
  leaseToken,
  newHandle,
  jobId,
  expiresAt = null,
  lastAgentCallId = null,
} = {}) {
  const db = getDb();
  const ts = now();
  const result = db.prepare(`
    UPDATE job_sessions
    SET handle = ?,
        parent_job_id = ?,
        hop_count = hop_count + 1,
        last_used_at = ?,
        expires_at = COALESCE(?, expires_at),
        leased_by = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_agent_call_id = COALESCE(?, last_agent_call_id)
    WHERE id = ? AND lease_token = ? AND status = 'active'
  `).run(
    String(newHandle || ""),
    jobId == null ? null : Number(jobId),
    ts,
    expiresAt || null,
    lastAgentCallId == null ? null : Number(lastAgentCallId),
    Number(sessionId),
    String(leaseToken || ""),
  );
  if (result.changes === 0) return null;
  const row = db.prepare(`SELECT * FROM job_sessions WHERE id = ?`).get(Number(sessionId));
  logEvent({
    work_item_id: row.work_item_id,
    job_id: jobId == null ? null : Number(jobId),
    event_type: EVENT_TYPES.SESSION_ADVANCED,
    actor_type: EVENT_ACTORS.SYSTEM,
    message: `Advanced ${row.lane} session to hop ${row.hop_count}`,
    event_json: JSON.stringify({ session_id: row.id, lane_id: row.lane_id, provider: row.provider, hop_count: row.hop_count }),
  });
  return row;
}

export function markSessionExpired(sessionId, reason = "expired") {
  return markSessionStatus(sessionId, "expired", reason);
}

export function markSessionFailed(sessionId, reason = "failed") {
  return markSessionStatus(sessionId, "failed", reason);
}

export function markSessionStatus(sessionId, status, reason = status) {
  const db = getDb();
  const ts = now();
  const row = db.prepare(`SELECT * FROM job_sessions WHERE id = ?`).get(Number(sessionId));
  const result = db.prepare(`
    UPDATE job_sessions
    SET status = ?, reason = ?, leased_by = NULL, lease_token = NULL,
        lease_expires_at = NULL, last_used_at = ?
    WHERE id = ? AND status = 'active'
  `).run(status, reason, ts, Number(sessionId));
  if (result.changes > 0 && row) {
    logEvent({
      work_item_id: row.work_item_id,
      job_id: row.leased_by || null,
      event_type: status === "expired" ? EVENT_TYPES.SESSION_EXPIRED : EVENT_TYPES.SESSION_FAILED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Session ${status}: ${reason}`,
      event_json: JSON.stringify({ session_id: row.id, lane_id: row.lane_id, provider: row.provider, reason }),
    });
  }
  return result.changes;
}

export function expireStaleSessionLeases(reason = "lease_expired") {
  const db = getDb();
  const ts = now();
  const rows = db.prepare(`
    SELECT * FROM job_sessions
    WHERE status = 'active'
      AND lease_expires_at IS NOT NULL
      AND lease_expires_at < ?
  `).all(ts);
  const clearStmt = db.prepare(`
    UPDATE job_sessions
    SET leased_by = NULL, lease_token = NULL, lease_expires_at = NULL,
        reason = ?, last_used_at = ?
    WHERE id = ? AND status = 'active'
      AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
  `);
  let count = 0;
  for (const row of rows) {
    // Re-check expiry in the UPDATE so a lease renewed between the SELECT and
    // here isn't clobbered (TOCTOU hygiene, matching the job-lease sweeps). (B5)
    const result = clearStmt.run(reason, ts, row.id, ts);
    if (result.changes <= 0) continue;
    count += result.changes;
    logEvent({
      work_item_id: row.work_item_id,
      job_id: row.leased_by || null,
      event_type: EVENT_TYPES.SESSION_LEASE_EXPIRED,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Released stale ${row.lane} session lease`,
      event_json: JSON.stringify({ session_id: row.id, lane_id: row.lane_id, provider: row.provider, reason }),
    });
  }
  return count;
}

export function recordSessionRecycleSavings({
  jobId,
  workItemId,
  laneId,
  sessionId,
  role,
  provider,
  skillKey = "",
  hopCount = 0,
  tokensResume = 0,
  tokensFreshEstimate = 0,
  estimateMethod = "unknown",
} = {}) {
  const db = getDb();
  const resume = Math.max(0, Number(tokensResume) || 0);
  const fresh = Math.max(0, Number(tokensFreshEstimate) || 0);
  const info = db.prepare(`
    INSERT INTO session_recycle_savings (
      job_id, work_item_id, lane_id, session_id, role, provider, skill_key,
      hop_count, tokens_resume, tokens_fresh_estimate, tokens_saved,
      estimate_method, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(jobId),
    Number(workItemId),
    Number(laneId),
    Number(sessionId),
    String(role || ""),
    normalizeProvider(provider),
    normalizeSkillKey(skillKey),
    Number(hopCount) || 0,
    resume,
    fresh,
    fresh - resume,
    String(estimateMethod || "unknown"),
    now(),
  );
  return db.prepare(`SELECT * FROM session_recycle_savings WHERE id = ?`).get(info.lastInsertRowid);
}

export function listSessionRecycleSavings({ workItemId = null, provider = null } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (workItemId != null) {
    clauses.push("work_item_id = ?");
    params.push(Number(workItemId));
  }
  if (provider) {
    clauses.push("provider = ?");
    params.push(normalizeProvider(provider));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT * FROM session_recycle_savings
    ${where}
    ORDER BY recorded_at DESC, id DESC
  `).all(...params);
}

export function listSessionLanes({ workItemId = null, status = null } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (workItemId != null) {
    clauses.push("l.work_item_id = ?");
    params.push(Number(workItemId));
  }
  if (status) {
    clauses.push("l.status = ?");
    params.push(String(status));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT
      l.*,
      s.id AS active_session_id,
      s.handle AS active_session_handle,
      s.parent_job_id AS active_parent_job_id,
      s.hop_count AS active_hop_count,
      s.last_used_at AS active_last_used_at,
      s.expires_at AS active_expires_at,
      s.leased_by AS active_leased_by,
      s.lease_expires_at AS active_lease_expires_at
    FROM session_lanes l
    LEFT JOIN job_sessions s
      ON s.id = (
        SELECT js.id
        FROM job_sessions js
        WHERE js.lane_id = l.id AND js.status = 'active'
        ORDER BY js.last_used_at DESC, js.id DESC
        LIMIT 1
      )
    ${where}
    ORDER BY l.updated_at DESC, l.id DESC
  `).all(...params);
}

export function aggregateSessionRecycleSavings({ workItemId = null, provider = null, role = null } = {}) {
  const db = getDb();
  const clauses = [];
  const params = [];
  if (workItemId != null) {
    clauses.push("work_item_id = ?");
    params.push(Number(workItemId));
  }
  if (provider) {
    clauses.push("provider = ?");
    params.push(normalizeProvider(provider));
  }
  if (role) {
    clauses.push("role = ?");
    params.push(String(role));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT
      provider,
      role,
      skill_key,
      COUNT(*) AS samples,
      SUM(tokens_resume) AS tokens_resume,
      SUM(tokens_fresh_estimate) AS tokens_fresh_estimate,
      SUM(tokens_saved) AS tokens_saved,
      SUM(CASE WHEN tokens_saved < 0 THEN 1 ELSE 0 END) AS negative_samples
    FROM session_recycle_savings
    ${where}
    GROUP BY provider, role, skill_key
    ORDER BY tokens_saved DESC, samples DESC, provider, role, skill_key
  `).all(...params);
}

export function deriveSessionKeyForJob(job, opts = {}) {
  return deriveSessionKey(job, opts);
}
