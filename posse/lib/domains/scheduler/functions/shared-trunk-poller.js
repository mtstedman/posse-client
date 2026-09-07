// Scheduler-loop collaborator for shared-trunk freshness and advisory claims.
// It owns cadence only; Git serialization and durable recovery remain in the
// shared-trunk Git coordinator.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { ensureBridgeInstanceId } from "../../bridge/functions/auth.js";
import { getLivePairingState } from "../../pairing/functions/state.js";
import { readPairingPeerSnapshot } from "../../pairing/functions/work-items.js";
import { reconcileSessionDelegationCommits } from "../../queue/functions/session-job-router.js";
import {
  reconcileSharedTrunkOperations,
  syncSharedTrunkFromOrigin,
} from "../../git/functions/shared-trunk.js";
import { resolveSharedTrunkConfigRuntime } from "../../git/functions/shared-trunk-config.js";
import {
  createJob,
  listJobs,
  listActiveFileLocks,
  logEvent,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  syncCrossInstanceClaims,
  updateSharedTrunkRuntimeStatus,
} from "../../queue/functions/index.js";
import { updatePairingEnrollment } from "../../pairing/functions/state.js";

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function provenanceGateRows() {
  return listJobs().filter((job) => parseJson(job.payload_json)?.subtype === "shared_trunk_provenance");
}

function applyProvenanceGateDecision() {
  const state = getLivePairingState();
  if (!state) return null;
  const gate = provenanceGateRows().find((job) => {
    if (job.status !== "succeeded") return false;
    return parseJson(job.result_json)?.provenance_applied !== true;
  });
  if (!gate) return null;
  const payload = parseJson(gate.payload_json);
  const result = parseJson(gate.result_json);
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
  if (accepted && /^[0-9a-f]{40}$/iu.test(String(payload.remote_oid || ""))) {
    updatePairingEnrollment(state.id, { baselineOid: payload.remote_oid, phase: "active" });
  } else {
    updateSharedTrunkRuntimeStatus({ provenance_gate_rejected: true });
  }
  getDb().prepare("UPDATE jobs SET result_json=? WHERE id=?").run(JSON.stringify({
    ...result,
    provenance_applied: true,
    provenance_accepted: accepted,
  }), gate.id);
  return { gateId: gate.id, accepted };
}

function ensureProvenanceGate(result) {
  const status = readRuntimeStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK) || {};
  if (status.provenance_gate_rejected === true) return null;
  const existing = provenanceGateRows().find((job) => (
    ["queued", "leased", "running", "waiting_on_human", "blocked"].includes(job.status)
  ));
  if (existing) return existing;
  const remoteOid = result?.remoteSha || result?.newSha || status.remote_sha || null;
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
      commits,
    },
  });
  updateSharedTrunkRuntimeStatus({ provenance_gate_job_id: gate.id });
  return gate;
}

function positiveSeconds(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function claimNamespace(config) {
  if (!config?.enabled || config.claimsEnabled !== true) return null;
  const remote = String(config.remote || "").trim();
  const branch = String(config.branch || "").trim();
  return remote && branch ? `${remote}\0${branch}` : null;
}

export class SharedTrunkPoller {
  constructor({
    projectDir = process.cwd(),
    nowMs = () => Date.now(),
    resolveConfig = resolveSharedTrunkConfigRuntime,
    sync = syncSharedTrunkFromOrigin,
    reconcile = reconcileSharedTrunkOperations,
    syncClaims = syncCrossInstanceClaims,
    activeLocks = listActiveFileLocks,
    instanceId = ensureBridgeInstanceId,
    log = logEvent,
    readStatus = readRuntimeStatus,
    updateStatus = updateSharedTrunkRuntimeStatus,
  } = {}) {
    this.projectDir = projectDir;
    this._nowMs = nowMs;
    this._resolveConfig = resolveConfig;
    this._sync = sync;
    this._reconcile = reconcile;
    this._syncClaims = syncClaims;
    this._activeLocks = activeLocks;
    this._instanceId = instanceId;
    this._log = log;
    this._readStatus = readStatus;
    this._updateStatus = updateStatus;
    this._nextDueAt = 0;
    this._lastPollAt = null;
    this._inFlight = null;
    this._lastConfig = null;
    this._claimCursor = null;
    this._claimCycleStartedAt = null;
    this._claimNamespace = null;
  }

  delayUntilDueMs() {
    if (!this._lastConfig?.enabled) return null;
    return Math.max(0, this._nextDueAt - this._nowMs());
  }

  currentConfig() {
    return this._lastConfig;
  }

  poll({ force = false, idle = false } = {}) {
    if (this._inFlight) return this._inFlight;
    const run = this._pollOnce({ force, idle });
    const tracked = run.finally(() => {
      if (this._inFlight === tracked) this._inFlight = null;
    });
    this._inFlight = tracked;
    return tracked;
  }

  async _pollOnce({ force = false, idle = false } = {}) {
    applyProvenanceGateDecision();
    // A failed configuration resolve is held for one cadence window: the run
    // loop calls poll() every lap, and re-resolving (and re-logging) a known
    // bad config per lap is the busy-spin this guard exists to prevent.
    if (!force && this._configErrorAt != null && this._nowMs() < this._nextDueAt) {
      return { attempted: false, unavailable: true, configurationError: true, skipped: "cadence" };
    }
    let config;
    try {
      config = await this._resolveConfig(this.projectDir, { nativeCapabilityPreflight: true });
    } catch (err) {
      // An explicitly enabled but invalid configuration is a fail-closed
      // health condition. Surface it; never quietly run the local-only path.
      // Cadence must still advance here: a stale enabled _lastConfig with a
      // past-due _nextDueAt would otherwise pin delayUntilDueMs() at 0 and
      // spin the scheduler run loop, logging one event per lap.
      const errorNow = this._nowMs();
      const errorIntervalSec = positiveSeconds(
        idle ? this._lastConfig?.fetchIntervalIdleSec : this._lastConfig?.fetchIntervalSec,
        idle ? 300 : 30,
      );
      this._lastPollAt = errorNow;
      this._nextDueAt = errorNow + errorIntervalSec * 1000;
      this._configErrorAt = errorNow;
      this._log({
        event_type: EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Shared-trunk configuration is invalid: ${err?.message || err}`,
        event_json: JSON.stringify({ error: err?.message || String(err), configuration_error: true }),
      });
      return { attempted: false, unavailable: true, configurationError: true, error: err };
    }
    this._configErrorAt = null;
    this._lastConfig = config;
    if (!config?.enabled) {
      this._nextDueAt = 0;
      this._claimCursor = null;
      this._claimCycleStartedAt = null;
      this._claimNamespace = null;
      // One-shot correction of persisted health after the feature is turned
      // off, so status projections and tool-time claim warnings stop reading
      // a stale enabled=true snapshot.
      try {
        const prior = this._readStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK);
        if (prior?.enabled === true) {
          this._updateStatus({ enabled: false, claims_enabled: false });
        }
      } catch { /* best-effort status hygiene */ }
      return { attempted: false, skipped: "disabled", config };
    }
    const now = this._nowMs();
    const namespace = claimNamespace(config);
    if (namespace !== this._claimNamespace) {
      this._claimCursor = null;
      this._claimCycleStartedAt = null;
      this._claimNamespace = namespace;
    }
    if (namespace && !this._claimCycleStartedAt) {
      this._claimCycleStartedAt = new Date(now).toISOString();
    } else if (!namespace) {
      this._claimCursor = null;
      this._claimCycleStartedAt = null;
    }
    const intervalSec = positiveSeconds(
      idle ? config.fetchIntervalIdleSec : config.fetchIntervalSec,
      idle ? 300 : 30,
    );
    const dueAt = this._lastPollAt == null ? 0 : this._lastPollAt + intervalSec * 1000;
    this._nextDueAt = dueAt;
    if (!force && now < dueAt) {
      return { attempted: false, skipped: "cadence", config, nextDueAt: dueAt };
    }
    // Set the next due time before awaiting network I/O so a concurrent caller
    // coalesces rather than launching a second fetch.
    this._lastPollAt = now;
    this._nextDueAt = now + intervalSec * 1000;
    try {
      const recovery = await this._reconcile(this.projectDir, {
        includeClaims: config.claimsEnabled === true,
        ...(this._claimCursor ? { claimAfter: this._claimCursor } : {}),
      });
      if (recovery?.blocked || recovery?.diverged || (recovery?.unresolved?.length || 0) > 0) {
        // Blocked recovery halts trunk writes, but its completed claim-
        // inclusive fetch is still authoritative for the advisory mirror —
        // without this the peer-claim view ages for as long as one journal
        // row stays unresolved.
        await this._reconcileClaims(recovery, recovery?.config || config);
        return { attempted: true, config, recovery, blocked: true };
      }
      const result = await this._sync(this.projectDir, {
        includeClaims: config.claimsEnabled === true,
        ...(this._claimCursor ? { claimAfter: this._claimCursor } : {}),
        ...this._provenanceContext(),
      });
      const effectiveConfig = result?.config || config;
      if (result?.reason === "shared_trunk_provenance_blocked") ensureProvenanceGate(result);
      if (result?.ok && /^[0-9a-f]{40}$/iu.test(String(result.newSha || ""))) {
        const live = getLivePairingState();
        if (live?.phase === "active" && live.baseline_oid !== result.newSha) {
          updatePairingEnrollment(live.id, { baselineOid: result.newSha, phase: "active" });
          updateSharedTrunkRuntimeStatus({ provenance_gate_rejected: false, provenance_gate_job_id: null });
        }
      }
      await this._reconcileClaims(result, effectiveConfig);
      await reconcileSessionDelegationCommits(this.projectDir);
      return { ...result, config: effectiveConfig, recovery };
    } catch (err) {
      // Fetch/transport is fail-open for job dispatch. The merge coordinator
      // still fails closed before any trunk write.
      this._log({
        event_type: EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Shared-trunk fetch failed; dispatch will continue: ${err?.message || err}`,
        event_json: JSON.stringify({ error: err?.message || String(err), fail_open: true }),
      });
      return { attempted: true, unavailable: true, config, error: err };
    }
  }

  _provenanceContext() {
    const session = getLivePairingState();
    if (!session?.baseline_oid || session.phase !== "active") return {};
    const snapshot = readPairingPeerSnapshot();
    const gitIdentities = (snapshot?.peers || [])
      .flatMap((peer) => Array.isArray(peer.git_identities) ? peer.git_identities : []);
    return {
      provenance: {
        baselineOid: session.baseline_oid,
        gitIdentities,
      },
    };
  }

  // Claims reconcile only against a fetch that actually completed — the
  // `fetchCompleted` stamp exists on every sync/reconcile result whose native
  // fetch succeeded (diverged and blocked outcomes included: the claim
  // snapshot they carry is real). A skipped, lock-busy, or unavailable result
  // never carries the stamp, and treating its empty list as complete would
  // wipe the durable peer-claim mirror.
  async _reconcileClaims(result, config) {
    if (config?.claimsEnabled !== true) return;
    if (result?.fetchCompleted !== true) return;
    if (!this._claimCycleStartedAt || claimNamespace(config) !== this._claimNamespace) {
      // The fetch omitted claims or resolved a different remote/branch after
      // this cycle began. Never combine namespaces or treat an empty,
      // non-claim fetch as an authoritative snapshot.
      this._claimCursor = null;
      this._claimCycleStartedAt = null;
      this._claimNamespace = null;
      return;
    }
    try {
      const paginationSupported = result?.claimsPaginationSupported === true;
      const nextCursor = paginationSupported && /^[0-9a-f]{64}$/u.test(result?.claimsNextCursor || "")
        ? result.claimsNextCursor
        : null;
      if (nextCursor && this._claimCursor && nextCursor <= this._claimCursor) {
        throw new Error("Shared-trunk claim cursor did not advance");
      }
      const snapshotComplete = paginationSupported
        ? nextCursor == null
        : result?.claimsTruncated !== true;
      await this._syncClaims({
        projectDir: this.projectDir,
        config,
        instanceId: this._instanceId(this.projectDir),
        fetchedClaims: result?.fetchedClaims || [],
        claimsTruncated: result?.claimsTruncated === true,
        claimSnapshotComplete: snapshotComplete,
        claimSnapshotStartedAt: paginationSupported ? this._claimCycleStartedAt : null,
        activeLocks: this._activeLocks(),
      });
      if (paginationSupported && nextCursor) {
        this._claimCursor = nextCursor;
      } else {
        this._claimCursor = null;
        this._claimCycleStartedAt = null;
      }
    } catch (err) {
      // Claims are explicitly fail-open. Keep trunk sync success and make
      // the degraded optimization visible without blocking dispatch.
      this._log({
        event_type: EVENT_TYPES.SHARED_TRUNK_CLAIM_SYNC_FAILED,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Shared-trunk claim refresh failed: ${err?.message || err}`,
        event_json: JSON.stringify({ error: err?.message || String(err) }),
      });
    }
  }
}

export function createSharedTrunkPoller(options = {}) {
  return new SharedTrunkPoller(options);
}
