// Advisory cross-instance write claims mirrored through refs/posse/claims/*.
//
// Claims deliberately never participate in the authoritative lease/lock
// transaction. A stale, malformed, or unreachable claim service must only
// cost throughput; Git remains the cross-instance correctness boundary.

import crypto from "node:crypto";

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { isUnderRoot, rootsOverlap } from "../../../shared/scope/functions/path.js";
import { casPushSharedTrunkClaimNative } from "../../git/functions/shared-trunk-native.js";
import { now, runImmediateTransaction } from "./common.js";
import { logEvent } from "./events.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS } from "./runtime-status.js";
import { notifyQueueStateChanged } from "./wakeups.js";

const CLAIM_PROTOCOL = "posse.shared_trunk_claim.v1";
const CLAIM_REF_PREFIX = "refs/posse/claims/";
const CLAIM_KEY_RE = /^[0-9a-f]{64}$/;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Keep the JS projection aligned with the native fetch contract. The native
// side reports truncation explicitly when the remote namespace is larger.
const MAX_CLAIMS_PER_FETCH = 128;
const MAX_LOCAL_CLAIMS = 128;
const MAX_PAYLOAD_BYTES = 8192;
const MAX_PATH_CHARS = 4096;
const MAX_ID_CHARS = 160;

function normalizePath(value) {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!normalized || normalized.length > MAX_PATH_CHARS) return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeScopeKind(value, pathValue) {
  if (value === "file") return "file";
  if (value === "root") return "root";
  if (pathValue === "*") return "root";
  return null;
}

export function sharedTrunkClaimKey(pathValue, scopeKind = "file") {
  const path = normalizePath(pathValue);
  const kind = normalizeScopeKind(scopeKind, path);
  if (!path || !kind) return null;
  return crypto.createHash("sha256").update(`${kind}\0${path}`, "utf8").digest("hex");
}

function boundedString(value, max = MAX_ID_CHARS) {
  const text = String(value || "").trim();
  return text && text.length <= max ? text : null;
}

function parsePayloadText(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PAYLOAD_BYTES
        ? value
        : null;
    } catch {
      return null;
    }
  }
  const text = String(value || "");
  if (!text || Buffer.byteLength(text, "utf8") > MAX_PAYLOAD_BYTES) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function claimRefAndKey(raw = {}) {
  const ref = boundedString(raw.ref || raw.refName || raw.ref_name, 256);
  const explicitKey = boundedString(raw.claimKey || raw.claim_key, 64);
  const key = explicitKey || (ref?.startsWith(CLAIM_REF_PREFIX) ? ref.slice(CLAIM_REF_PREFIX.length) : null);
  if (!CLAIM_KEY_RE.test(key || "")) return null;
  if (ref && ref !== `${CLAIM_REF_PREFIX}${key}`) return null;
  return { ref: `${CLAIM_REF_PREFIX}${key}`, key };
}

function normalizeFetchedClaim(raw, {
  observedAtMs = Date.now(),
  ttlMin = 30,
} = {}) {
  const refData = claimRefAndKey(raw);
  if (!refData) return null;
  const objectOid = boundedString(raw.objectOid || raw.object_oid || raw.oid, 64);
  if (!OBJECT_ID_RE.test(objectOid || "")) return null;
  const payload = parsePayloadText(raw.payload ?? raw.payloadJson ?? raw.payload_json);
  if (!payload || payload.protocol !== CLAIM_PROTOCOL) return null;
  const instanceId = boundedString(payload.instance_id);
  const path = normalizePath(payload.path);
  const scopeKind = normalizeScopeKind(payload.scope_kind, path);
  if (!instanceId || !path || !scopeKind || payload.kind !== "hard") return null;
  if (sharedTrunkClaimKey(path, scopeKind) !== refData.key) return null;
  const wiId = Number(payload.wi_id);
  const jobId = payload.job_id == null ? null : Number(payload.job_id);
  if (!Number.isSafeInteger(wiId) || wiId <= 0) return null;
  if (jobId != null && (!Number.isSafeInteger(jobId) || jobId <= 0)) return null;
  const suppliedExpiryMs = Date.parse(payload.expires_at || "");
  if (!Number.isFinite(suppliedExpiryMs) || suppliedExpiryMs <= observedAtMs) return null;
  const maxTtlMs = Math.max(1, Number(ttlMin) || 30) * 60_000;
  const effectiveExpiryMs = Math.min(suppliedExpiryMs, observedAtMs + maxTtlMs);
  return {
    claim_key: refData.key,
    ref_name: refData.ref,
    object_oid: objectOid,
    instance_id: instanceId,
    work_item_id: wiId,
    job_id: jobId,
    path,
    scope_kind: scopeKind,
    lifecycle_kind: "hard",
    expires_at: new Date(effectiveExpiryMs).toISOString(),
    observed_at: new Date(observedAtMs).toISOString(),
    payload_json: JSON.stringify(payload),
  };
}

function expiredFetchedClaim(raw, observedAtMs = Date.now()) {
  const refData = claimRefAndKey(raw);
  if (!refData) return null;
  const objectOid = boundedString(raw.objectOid || raw.object_oid || raw.oid, 64);
  if (!OBJECT_ID_RE.test(objectOid || "")) return null;
  const payload = parsePayloadText(raw.payload ?? raw.payloadJson ?? raw.payload_json);
  if (!payload || payload.protocol !== CLAIM_PROTOCOL || payload.kind !== "hard") return null;
  const path = normalizePath(payload.path);
  const scopeKind = normalizeScopeKind(payload.scope_kind, path);
  const expiresAtMs = Date.parse(payload.expires_at || "");
  if (!path || !scopeKind || sharedTrunkClaimKey(path, scopeKind) !== refData.key) return null;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > observedAtMs) return null;
  return { claimKey: refData.key, objectOid };
}

export function normalizeFetchedSharedTrunkClaims(fetchedClaims, options = {}) {
  const rows = [];
  for (const raw of Array.isArray(fetchedClaims) ? fetchedClaims.slice(0, MAX_CLAIMS_PER_FETCH) : []) {
    const row = normalizeFetchedClaim(raw, options);
    if (row) rows.push(row);
  }
  return rows;
}

function replacePeerClaims(rows, instanceId, {
  completeSnapshot = true,
  snapshotStartedAt = null,
} = {}) {
  const db = getDb();
  const observedAt = now();
  const peerRows = rows.filter((row) => row.instance_id !== instanceId);
  runImmediateTransaction(db, () => {
    const upsert = db.prepare(`
      INSERT INTO shared_trunk_peer_claims (
        claim_key, ref_name, object_oid, instance_id, work_item_id, job_id,
        path, scope_kind, lifecycle_kind, expires_at, observed_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(claim_key) DO UPDATE SET
        ref_name = excluded.ref_name,
        object_oid = excluded.object_oid,
        instance_id = excluded.instance_id,
        work_item_id = excluded.work_item_id,
        job_id = excluded.job_id,
        path = excluded.path,
        scope_kind = excluded.scope_kind,
        lifecycle_kind = excluded.lifecycle_kind,
        expires_at = excluded.expires_at,
        observed_at = excluded.observed_at,
        payload_json = excluded.payload_json
    `);
    const seen = new Set();
    for (const row of peerRows) {
      seen.add(row.claim_key);
      upsert.run(
        row.claim_key,
        row.ref_name,
        row.object_oid,
        row.instance_id,
        row.work_item_id,
        row.job_id,
        row.path,
        row.scope_kind,
        row.lifecycle_kind,
        row.expires_at,
        row.observed_at,
        row.payload_json,
      );
    }
    // A truncated native fetch is not authority that omitted refs vanished.
    // Preserve the prior mirror until a complete snapshot or TTL expiry.
    if (completeSnapshot) {
      const cycleStartedMs = Date.parse(snapshotStartedAt || "");
      if (Number.isFinite(cycleStartedMs)) {
        // A paginated cycle has already upserted earlier pages. Remove only
        // rows that were not observed anywhere in this completed traversal.
        db.prepare("DELETE FROM shared_trunk_peer_claims WHERE observed_at < ?")
          .run(new Date(cycleStartedMs).toISOString());
      } else if (seen.size === 0) {
        db.prepare("DELETE FROM shared_trunk_peer_claims").run();
      } else {
        const placeholders = [...seen].map(() => "?").join(",");
        db.prepare(`DELETE FROM shared_trunk_peer_claims WHERE claim_key NOT IN (${placeholders})`)
          .run(...seen);
      }
    }
    db.prepare("DELETE FROM shared_trunk_peer_claims WHERE expires_at <= ?").run(observedAt);
  });
  return peerRows;
}

function activeLockClaims(activeLocks, instanceId, ttlMin, nowMs = Date.now()) {
  const rows = [
    ...(activeLocks?.work_items || []),
    ...(activeLocks?.jobs || []),
  ];
  const desired = new Map();
  const expiresAt = new Date(nowMs + Math.max(1, Number(ttlMin) || 30) * 60_000).toISOString();
  for (const raw of rows) {
    const path = normalizePath(raw.path);
    const scopeKind = normalizeScopeKind(raw.lock_kind, path);
    const wiId = Number(raw.work_item_id);
    const jobId = raw.job_id == null ? null : Number(raw.job_id);
    if (!path || !scopeKind || !Number.isSafeInteger(wiId) || wiId <= 0) continue;
    const claimKey = sharedTrunkClaimKey(path, scopeKind);
    if (!claimKey || desired.has(claimKey)) continue;
    const payload = {
      protocol: CLAIM_PROTOCOL,
      instance_id: instanceId,
      wi_id: wiId,
      job_id: Number.isSafeInteger(jobId) && jobId > 0 ? jobId : null,
      path,
      scope_kind: scopeKind,
      kind: "hard",
      expires_at: expiresAt,
    };
    desired.set(claimKey, {
      claimKey,
      path,
      scopeKind,
      workItemId: wiId,
      jobId: payload.job_id,
      expiresAt,
      payload,
    });
    if (desired.size >= MAX_LOCAL_CLAIMS) break;
  }
  return desired;
}

function localClaimRows() {
  return getDb().prepare("SELECT * FROM shared_trunk_local_claims ORDER BY claim_key").all();
}

function upsertLocalClaim(desired, instanceId, objectOid) {
  const db = getDb();
  runImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO shared_trunk_local_claims (
        claim_key, object_oid, instance_id, work_item_id, job_id, path,
        scope_kind, lifecycle_kind, expires_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'hard', ?, ?)
      ON CONFLICT(claim_key) DO UPDATE SET
        object_oid = excluded.object_oid,
        instance_id = excluded.instance_id,
        work_item_id = excluded.work_item_id,
        job_id = excluded.job_id,
        path = excluded.path,
        scope_kind = excluded.scope_kind,
        lifecycle_kind = excluded.lifecycle_kind,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).run(
      desired.claimKey,
      objectOid,
      instanceId,
      desired.workItemId,
      desired.jobId,
      desired.path,
      desired.scopeKind,
      desired.expiresAt,
      now(),
    );
  });
}

function deleteLocalClaim(claimKey) {
  const db = getDb();
  runImmediateTransaction(db, () => {
    db.prepare("DELETE FROM shared_trunk_local_claims WHERE claim_key = ?").run(claimKey);
  });
}

function resultStatus(result) {
  const value = result && typeof result.result === "object" ? result.result : result;
  return String(value?.status || value?.outcome || "").trim();
}

function nativeResult(result) {
  return result && typeof result.result === "object" ? result.result : result;
}

/**
 * Reconcile hard local file locks with remote claim refs after a successful
 * claim-inclusive fetch. Operational failures are reported to the caller and
 * never block local work.
 */
export async function syncCrossInstanceClaims({
  projectDir,
  config,
  instanceId,
  fetchedClaims = [],
  claimsTruncated = false,
  claimSnapshotComplete = null,
  claimSnapshotStartedAt = null,
  activeLocks = { work_items: [], jobs: [] },
  casPush = casPushSharedTrunkClaimNative,
} = {}) {
  if (!config?.enabled || !config?.claimsEnabled) return { attempted: false, skipped: "disabled" };
  const owner = boundedString(instanceId);
  if (!owner) return { attempted: false, skipped: "missing_instance_id" };

  const observedAtMs = Date.now();
  const boundedFetched = Array.isArray(fetchedClaims)
    ? fetchedClaims.slice(0, MAX_CLAIMS_PER_FETCH)
    : [];
  const normalized = normalizeFetchedSharedTrunkClaims(boundedFetched, {
    observedAtMs,
    ttlMin: config.claimsTtlMin,
  });
  const completeSnapshot = claimSnapshotComplete == null
    ? claimsTruncated !== true
    : claimSnapshotComplete === true;
  const peerRows = replacePeerClaims(normalized, owner, {
    completeSnapshot,
    snapshotStartedAt: claimSnapshotStartedAt,
  });
  const remoteByKey = new Map(normalized.map((row) => [row.claim_key, row]));
  let expiredReleased = 0;
  let lostRaces = 0;
  for (const expired of boundedFetched
    .map((raw) => expiredFetchedClaim(raw, observedAtMs))
    .filter(Boolean)) {
    const result = await casPush({
      cwd: projectDir,
      remote: config.remote,
      claimKey: expired.claimKey,
      expectedOldOid: expired.objectOid,
      payload: null,
    });
    if (result?.available === false) {
      throw new Error(`Shared-trunk claim capability unavailable: ${result.reason || "unknown"}`);
    }
    const status = resultStatus(result);
    if (status === "applied") {
      const local = getDb().prepare(
        "SELECT object_oid FROM shared_trunk_local_claims WHERE claim_key = ?",
      ).get(expired.claimKey);
      if (local?.object_oid === expired.objectOid) deleteLocalClaim(expired.claimKey);
      expiredReleased += 1;
    } else if (status === "lost_race") {
      lostRaces += 1;
    } else {
      throw new Error(`Unexpected expired shared-trunk claim cleanup outcome: ${status || "missing"}`);
    }
  }
  const localRows = localClaimRows();
  const localByKey = new Map(localRows.map((row) => [row.claim_key, row]));
  const desired = activeLockClaims(activeLocks, owner, config.claimsTtlMin);
  const renewalFloorMs = Date.now() + Math.max(1, Number(config.claimsTtlMin) || 30) * 30_000;
  let published = 0;
  let released = 0;

  for (const [claimKey, claim] of desired) {
    const remote = remoteByKey.get(claimKey) || null;
    const local = localByKey.get(claimKey) || null;
    if (remote && remote.instance_id !== owner) {
      if (local) deleteLocalClaim(claimKey);
      lostRaces += 1;
      continue;
    }
    if (
      remote
      && local
      && remote.object_oid === local.object_oid
      && Date.parse(local.expires_at || "") > renewalFloorMs
    ) {
      continue;
    }
    // When the native snapshot was truncated, the durable local mirror still
    // carries the last OID we successfully published. Use it as the CAS lease
    // instead of attempting an unsafe create.
    const expectedOldOid = remote?.object_oid || local?.object_oid || null;
    const result = await casPush({
      cwd: projectDir,
      remote: config.remote,
      claimKey,
      expectedOldOid,
      payload: claim.payload,
    });
    if (result?.available === false) {
      throw new Error(`Shared-trunk claim capability unavailable: ${result.reason || "unknown"}`);
    }
    const status = resultStatus(result);
    if (status === "lost_race") {
      lostRaces += 1;
      if (local) deleteLocalClaim(claimKey);
      continue;
    }
    if (status !== "applied") {
      throw new Error(`Unexpected shared-trunk claim publish outcome: ${status || "missing"}`);
    }
    const applied = nativeResult(result);
    const objectOid = applied?.newOid || applied?.new_oid || applied?.objectOid || applied?.object_oid;
    if (!OBJECT_ID_RE.test(String(objectOid || ""))) {
      throw new Error("Shared-trunk claim publish did not return a valid object id");
    }
    upsertLocalClaim(claim, owner, String(objectOid));
    published += 1;
  }

  for (const local of localRows) {
    if (desired.has(local.claim_key)) continue;
    const remote = remoteByKey.get(local.claim_key);
    if (remote && (remote.instance_id !== owner || remote.object_oid !== local.object_oid)) {
      deleteLocalClaim(local.claim_key);
      continue;
    }
    const result = await casPush({
      cwd: projectDir,
      remote: config.remote,
      claimKey: local.claim_key,
      expectedOldOid: local.object_oid,
      payload: null,
    });
    if (result?.available === false) {
      throw new Error(`Shared-trunk claim capability unavailable: ${result.reason || "unknown"}`);
    }
    const status = resultStatus(result);
    if (status === "applied" || status === "lost_race") {
      deleteLocalClaim(local.claim_key);
      if (status === "applied") released += 1;
      else lostRaces += 1;
      continue;
    }
    throw new Error(`Unexpected shared-trunk claim release outcome: ${status || "missing"}`);
  }

  if (published || released || expiredReleased || lostRaces || peerRows.length) {
    notifyQueueStateChanged({ reason: "shared_trunk_claims_refreshed" });
  }
  return {
    attempted: true,
    peerClaims: peerRows.length,
    desiredClaims: desired.size,
    published,
    released,
    expiredReleased,
    lostRaces,
  };
}

export function listActivePeerClaims({ at = now() } = {}) {
  try {
    return getDb().prepare(`
      SELECT * FROM shared_trunk_peer_claims
      WHERE expires_at > ?
      ORDER BY claim_key
    `).all(at);
  } catch {
    return [];
  }
}

function rowsConflict(lock, candidate) {
  if (candidate.lock_kind === "file" && lock.scope_kind === "file") return candidate.path === lock.path;
  if (candidate.lock_kind === "file" && lock.scope_kind === "root") return isUnderRoot(candidate.path, [lock.path]);
  if (candidate.lock_kind === "root" && lock.scope_kind === "file") return isUnderRoot(lock.path, [candidate.path]);
  if (candidate.lock_kind === "root" && lock.scope_kind === "root") return rootsOverlap(candidate.path, lock.path);
  return false;
}

export function findPeerClaimConflict(jobScope, { instanceId = null } = {}) {
  const candidates = [];
  for (const raw of jobScope?.files || []) {
    const path = normalizePath(raw);
    if (path) candidates.push({ path, lock_kind: "file" });
  }
  for (const raw of jobScope?.createRoots || jobScope?.roots || []) {
    const path = normalizePath(raw);
    if (path) candidates.push({ path, lock_kind: "root" });
  }
  if (candidates.length === 0) return null;
  for (const claim of listActivePeerClaims()) {
    if (instanceId && claim.instance_id === instanceId) continue;
    const candidate = candidates.find((row) => rowsConflict(claim, row));
    if (candidate) return { claim, candidate };
  }
  return null;
}

function claimIdentity(claim) {
  // Deliberately excludes object_oid: the holder republishes each claim with
  // a fresh expiry (new blob OID) at ~half TTL, and a renewal must NOT reset
  // the observer's deferral age or hardening would be unreachable. Identity
  // changes only when a different instance or a different peer work item
  // takes the claim over.
  return `${claim?.claim_key || ""}:${claim?.instance_id || ""}:${claim?.work_item_id || ""}`;
}

/** Persist restart-safe advisory deferral age for one peer claim. */
export function recordPeerClaimDeferral(job, conflict, { maxDeferMin = 30 } = {}) {
  const claim = conflict?.claim;
  if (!job?.id || !claim?.claim_key) return { defer: false, reason: "invalid" };
  const db = getDb();
  const at = now();
  const atMs = Date.parse(at);
  const identity = claimIdentity(claim);
  const result = runImmediateTransaction(db, () => {
    let row = db.prepare(`
      SELECT * FROM shared_trunk_claim_deferrals
      WHERE job_id = ? AND claim_key = ?
    `).get(job.id, claim.claim_key);
    let changed = false;
    if (!row || row.claim_identity !== identity) {
      db.prepare(`
        INSERT INTO shared_trunk_claim_deferrals (
          job_id, work_item_id, claim_key, claim_identity, first_deferred_at,
          last_deferred_at, hardened_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(job_id, claim_key) DO UPDATE SET
          work_item_id = excluded.work_item_id,
          claim_identity = excluded.claim_identity,
          first_deferred_at = excluded.first_deferred_at,
          last_deferred_at = excluded.last_deferred_at,
          hardened_at = NULL
      `).run(job.id, job.work_item_id, claim.claim_key, identity, at, at);
      row = { first_deferred_at: at, hardened_at: null };
      changed = true;
    } else {
      db.prepare(`
        UPDATE shared_trunk_claim_deferrals
        SET last_deferred_at = ?
        WHERE job_id = ? AND claim_key = ?
      `).run(at, job.id, claim.claim_key);
    }
    const firstMs = Date.parse(row.first_deferred_at || at);
    const maxAgeMs = Math.max(0, Number(maxDeferMin) || 0) * 60_000;
    const expired = Date.parse(claim.expires_at || "") <= atMs;
    const harden = !!row.hardened_at || expired || atMs - firstMs >= maxAgeMs;
    if (harden && !row.hardened_at) {
      db.prepare(`
        UPDATE shared_trunk_claim_deferrals
        SET hardened_at = ?, last_deferred_at = ?
        WHERE job_id = ? AND claim_key = ?
      `).run(at, at, job.id, claim.claim_key);
      changed = true;
    }
    return { defer: !harden, hardened: harden, changed, firstDeferredAt: row.first_deferred_at || at };
  });
  const eventType = result.hardened
    ? EVENT_TYPES.SHARED_TRUNK_CLAIM_HARDENED
    : EVENT_TYPES.SHARED_TRUNK_CLAIM_DEFERRED;
  if (result.changed) {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: eventType,
      actor_type: EVENT_ACTORS.SCHEDULER,
      message: result.hardened
        ? `Dispatch proceeding despite peer claim on ${claim.path} after advisory wait budget`
        : `Dispatch deferred for peer claim on ${claim.path}`,
      event_json: JSON.stringify({
        claim_key: claim.claim_key,
        peer_instance_id: claim.instance_id,
        peer_work_item_id: claim.work_item_id,
        path: claim.path,
        scope_kind: claim.scope_kind,
        first_deferred_at: result.firstDeferredAt,
      }),
    });
  }
  return result;
}

export function clearPeerClaimDeferralsForJob(jobId) {
  try {
    const db = getDb();
    return runImmediateTransaction(db, () => (
      db.prepare("DELETE FROM shared_trunk_claim_deferrals WHERE job_id = ?").run(Number(jobId)).changes
    ));
  } catch {
    return 0;
  }
}

/** Emit a non-blocking, deduplicated tool-time notice for a peer collision. */
export function warnForPeerClaimAtToolWrite(job, filePath) {
  const path = normalizePath(filePath);
  if (!job?.id || !path) return null;
  const conflict = findPeerClaimConflict({ files: [path], createRoots: [] });
  if (!conflict) return null;
  const claim = conflict.claim;
  const db = getDb();
  const fingerprint = `${job.id}:${claimIdentity(claim)}:${path}`;
  const recent = db.prepare(`
    SELECT event_json FROM events
    WHERE job_id = ? AND event_type = ?
    ORDER BY id DESC LIMIT 1
  `).get(job.id, EVENT_TYPES.SHARED_TRUNK_CLAIM_WARNING);
  try {
    if (JSON.parse(recent?.event_json || "{}").fingerprint === fingerprint) return conflict;
  } catch { /* emit a fresh bounded warning */ }
  logEvent({
    work_item_id: job.work_item_id,
    job_id: job.id,
    event_type: EVENT_TYPES.SHARED_TRUNK_CLAIM_WARNING,
    actor_type: EVENT_ACTORS.WORKER,
    actor_id: `job-${job.id}`,
    message: `Peer instance ${claim.instance_id} is editing ${path}; a merge conflict is possible`,
    event_json: JSON.stringify({
      fingerprint,
      peer_instance_id: claim.instance_id,
      peer_work_item_id: claim.work_item_id,
      path,
      advisory: true,
    }),
  });
  return conflict;
}

export function sharedTrunkClaimsEnabled() {
  try {
    const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK);
    return status?.enabled === true && status?.claims_enabled === true;
  } catch {
    return false;
  }
}

export const SHARED_TRUNK_CLAIM_PROTOCOL = CLAIM_PROTOCOL;
