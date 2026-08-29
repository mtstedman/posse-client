// Scheduler-loop collaborator for shared-trunk freshness and advisory claims.
// It owns cadence only; Git serialization and durable recovery remain in the
// shared-trunk Git coordinator.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { ensureBridgeInstanceId } from "../../bridge/functions/auth.js";
import {
  reconcileSharedTrunkOperations,
  syncSharedTrunkFromOrigin,
} from "../../git/functions/shared-trunk.js";
import { resolveSharedTrunkConfigRuntime } from "../../git/functions/shared-trunk-config.js";
import {
  listActiveFileLocks,
  logEvent,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  syncCrossInstanceClaims,
  updateSharedTrunkRuntimeStatus,
} from "../../queue/functions/index.js";

function positiveSeconds(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
    if (config.claimsEnabled === true && !this._claimCycleStartedAt) {
      this._claimCycleStartedAt = new Date().toISOString();
    } else if (config.claimsEnabled !== true) {
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
      });
      const effectiveConfig = result?.config || config;
      await this._reconcileClaims(result, effectiveConfig);
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

  // Claims reconcile only against a fetch that actually completed — the
  // `fetchCompleted` stamp exists on every sync/reconcile result whose native
  // fetch succeeded (diverged and blocked outcomes included: the claim
  // snapshot they carry is real). A skipped, lock-busy, or unavailable result
  // never carries the stamp, and treating its empty list as complete would
  // wipe the durable peer-claim mirror.
  async _reconcileClaims(result, config) {
    if (config?.claimsEnabled !== true) return;
    if (result?.fetchCompleted !== true) return;
    try {
      const paginationSupported = result?.claimsPaginationSupported === true;
      const nextCursor = paginationSupported && /^[0-9a-f]{64}$/u.test(result?.claimsNextCursor || "")
        ? result.claimsNextCursor
        : null;
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
