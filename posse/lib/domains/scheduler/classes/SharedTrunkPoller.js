// Scheduler-loop collaborator for shared-trunk freshness and advisory claims.
// It owns cadence only; Git serialization and durable recovery remain in the
// shared-trunk Git coordinator.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import {
  PEER_TRUNK_HEAD_RELATIONS,
  SESSION_SYNC_POLICY,
  TRUNK_HEAD_PATTERN,
} from "../../../catalog/session-sync.js";
import { getLivePairingState, sessionInstanceId } from "../../pairing/functions/state.js";
import {
  clearSessionHold,
  readSessionHoldStatus,
  SESSION_HOLD_STATES,
} from "../../pairing/functions/session-hold.js";
import { pairingSessionProvenance } from "../../pairing/functions/work-items.js";
import { reconcileSessionDelegationCommits } from "../../queue/functions/session-job-router.js";
import {
  reconcileSharedTrunkOperations,
  syncSharedTrunkFromOrigin,
} from "../../git/functions/shared-trunk.js";
import { resolveSharedTrunkConfigRuntime } from "../../git/functions/shared-trunk-config.js";
import {
  classifyPeerTrunkHead,
  mergePeerHeadCache,
} from "../../git/functions/shared-trunk-peer-heads.js";
import {
  listActiveFileLocks,
  logEvent,
  readRuntimeStatus,
  RUNTIME_STATUS_KEYS,
  syncCrossInstanceClaims,
  updateSharedTrunkRuntimeStatus,
} from "../../queue/functions/index.js";
import { updatePairingEnrollment } from "../../pairing/functions/state.js";
import {
  applyProvenanceGateDecision,
  ensureProvenanceGate,
  retireOpenProvenanceGates,
} from "../../pairing/functions/provenance-gate.js";
import { abortError, throwIfAborted } from "../../runtime/functions/yield.js";

function positiveSeconds(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorCode(value, fallback) {
  const code = String(value || "").trim().replace(/[^A-Za-z0-9_.:-]+/gu, "_").slice(0, 80);
  return code || fallback;
}

/** Peer hints as [{ instance_id, role, trunk_head }] with a valid full head. */
function normalizePeerHints(hints) {
  const normalized = [];
  for (const hint of Array.isArray(hints) ? hints : []) {
    const head = String(hint?.trunk_head || "").toLowerCase();
    if (!TRUNK_HEAD_PATTERN.test(head)) continue;
    normalized.push({
      instance_id: String(hint?.instance_id || "").slice(0, 160),
      role: String(hint?.role || "").slice(0, 20),
      trunk_head: head,
    });
    if (normalized.length >= SESSION_SYNC_POLICY.PEER_SNAPSHOT_MAX_PEERS) break;
  }
  return normalized;
}

function rememberBounded(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
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
    // Claims carry the identity peers know this clone by: the session row's
    // inside a session, which a phone pairing's new bridge identity does not
    // replace (see sessionInstanceId).
    instanceId = sessionInstanceId,
    log = logEvent,
    readStatus = readRuntimeStatus,
    updateStatus = updateSharedTrunkRuntimeStatus,
    readHold = readSessionHoldStatus,
    clearHold = clearSessionHold,
    classifyHead = classifyPeerTrunkHead,
    pollDeadlineMs = 90_000,
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
    this._readHold = readHold;
    this._clearHold = clearHold;
    this._classifyHead = classifyHead;
    this._pollDeadlineMs = pollDeadlineMs;
    // Peer trunk-head hints: the latest advertised heads, heads already
    // covered by a completed fetch, heads absent after one (negative cache),
    // and peers muted after repeated unverifiable adverts.
    this._latestHints = [];
    this._triedHeads = new Map();
    this._negativeHeads = new Map();
    this._peerUnverified = new Map();
    this._mutedPeers = new Map();
    this._lastHintFetchAt = null;
    this._lastPollHeld = false;
    this._handledResumeKey = null;
    this._recordedIntervalSec = null;
    this._failureRecorded = false;
    this._nextDueAt = 0;
    this._lastPollAt = null;
    this._inFlight = null;
    this._lastConfig = null;
    this._claimCursor = null;
    this._claimCycleStartedAt = null;
    this._claimNamespace = null;
    this._activeController = null;
  }

  delayUntilDueMs() {
    if (!this._lastConfig?.enabled) return null;
    return Math.max(0, this._nextDueAt - this._nowMs());
  }

  currentConfig() {
    return this._lastConfig;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.force] bypass cadence
   * @param {boolean} [options.idle] use the idle cadence
   * @param {Array<{instance_id: string, role: string, trunk_head: string}>} [options.hints]
   *   peer trunk-head adverts; an unseen head can pull the next fetch earlier
   *   (at most once per HINT_FETCH_FLOOR_MS). Omitted keeps the last hints.
   */
  poll({ force = false, idle = false, hints = undefined } = {}) {
    if (Array.isArray(hints)) this._latestHints = normalizePeerHints(hints);
    if (this._inFlight) return this._inFlight;
    const run = this._pollOnce({ force, idle });
    const tracked = run.finally(() => {
      if (this._inFlight === tracked) this._inFlight = null;
    });
    this._inFlight = tracked;
    return tracked;
  }

  async _pollOnce(options = {}) {
    // Setup probes and lock/recovery work belong to the same lifetime as the
    // fetch. Owners must be able to cancel even before configuration resolves.
    const controller = new AbortController();
    this._activeController = controller;
    const deadline = setTimeout(() => controller.abort(Object.assign(new Error("Shared-trunk poll deadline exceeded"), {
      code: "shared_trunk_poll_deadline",
    })), this._pollDeadlineMs);
    deadline.unref?.();
    try {
      return await this._pollWithSignal({ ...options, signal: controller.signal });
    } finally {
      clearTimeout(deadline);
      if (this._activeController === controller) this._activeController = null;
    }
  }

  async _pollWithSignal({ force = false, idle = false, signal } = {}) {
    try {
      applyProvenanceGateDecision();
    } catch (error) {
      this._log({
        event_type: EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Shared-trunk provenance gate reconciliation failed: ${error?.message || error}`,
        event_json: JSON.stringify({ error: error?.message || String(error), fail_open: true }),
      });
    }
    // A resume request clears the hold and makes this poll due now; a hold
    // that expired or was cleared since the last held poll does the same, so
    // the frozen checkout catches up without waiting a cadence window.
    // Both triggers are one-shot, so a hold row that cannot be cleared never
    // turns into a forced poll per scheduler lap.
    const hold = this._holdStatus();
    const holdActive = hold.state === SESSION_HOLD_STATES.ACTIVE;
    let forced = force;
    if (hold.state === SESSION_HOLD_STATES.RESUME_REQUESTED) {
      const resumeKey = `${hold.hold?.state_id || ""}\0${hold.hold?.set_at || ""}`;
      try {
        this._clearHold({ stateId: hold.hold?.state_id, setAt: hold.hold?.set_at });
      } catch { /* the marked row is inert */ }
      if (this._handledResumeKey !== resumeKey) {
        this._handledResumeKey = resumeKey;
        forced = true;
      }
    } else if (this._lastPollHeld && !holdActive) {
      forced = true;
    }
    if (!holdActive) this._lastPollHeld = false;
    // A failed configuration resolve is held for one cadence window: the run
    // loop calls poll() every lap, and re-resolving (and re-logging) a known
    // bad config per lap is the busy-spin this guard exists to prevent.
    if (!forced && this._configErrorAt != null && this._nowMs() < this._nextDueAt) {
      return { attempted: false, unavailable: true, configurationError: true, skipped: "cadence" };
    }
    // An unseen peer-advertised head can pull the cadence fetch earlier, at
    // most once per floor window. It never adds a fetch of anything but the
    // named shared branch.
    const hinted = !forced && this._hintedFetchDue(this._nowMs());
    const cadenceIntervalSec = positiveSeconds(
      idle ? this._lastConfig?.fetchIntervalIdleSec : this._lastConfig?.fetchIntervalSec,
      idle ? 300 : 30,
    );
    const cachedDueAt = this._lastPollAt == null ? 0 : this._lastPollAt + cadenceIntervalSec * 1000;
    if (!forced && !hinted && this._lastConfig?.enabled && this._nowMs() < cachedDueAt) {
      this._nextDueAt = cachedDueAt;
      this._recordCadence(cadenceIntervalSec, cachedDueAt);
      return { attempted: false, skipped: "cadence", config: this._lastConfig, nextDueAt: cachedDueAt };
    }
    let config;
    try {
      config = await this._resolveConfig(this.projectDir, { nativeCapabilityPreflight: true, signal });
      throwIfAborted(signal);
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
      const configurationError = !signal?.aborted && err?.code !== "remote_default_unavailable";
      this._log({
        event_type: EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: configurationError
          ? `Shared-trunk configuration is invalid: ${err?.message || err}`
          : `Shared-trunk configuration probe is unavailable: ${err?.message || err}`,
        event_json: JSON.stringify({ error: err?.message || String(err), configuration_error: configurationError }),
      });
      this._recordFailure(
        signal?.aborted ? errorCode(signal.reason?.code, "ABORT_ERR")
          : errorCode(err?.code, configurationError ? "configuration_invalid" : "configuration_unavailable"),
        { configuration_error: configurationError },
      );
      return { attempted: false, unavailable: true, configurationError, error: err };
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
    if (!forced && !hinted && now < dueAt) {
      this._recordCadence(intervalSec, dueAt);
      return { attempted: false, skipped: "cadence", config, nextDueAt: dueAt };
    }
    // Set the next due time before awaiting network I/O so a concurrent caller
    // coalesces rather than launching a second fetch.
    this._lastPollAt = now;
    this._nextDueAt = now + intervalSec * 1000;
    if (hinted) this._lastHintFetchAt = now;
    this._recordCadence(intervalSec, this._nextDueAt, { force: true, configuration_error: false });
    const holdFastForward = holdActive;
    this._lastPollHeld = holdFastForward;
    try {
      throwIfAborted(signal);
      const session = getLivePairingState();
      const assertCurrent = () => {
        throwIfAborted(signal);
        const live = getLivePairingState();
        if (live?.id !== session?.id || live?.remote_session_id !== session?.remote_session_id
          || live?.phase !== session?.phase || live?.shared_branch !== session?.shared_branch) {
          throw abortError("Shared-trunk session changed during poll");
        }
      };
      const provenanceOptions = this._provenanceContext();
      const result = await this._sync(this.projectDir, {
        includeClaims: config.claimsEnabled === true,
        ...(this._claimCursor ? { claimAfter: this._claimCursor } : {}),
        ...provenanceOptions,
        ...(holdFastForward ? { holdFastForward: true } : {}),
        signal,
      });
      assertCurrent();
      const effectiveConfig = result?.config || config;
      if (provenanceOptions.provenance && result?.ok === true && result?.fetchCompleted === true) {
        retireOpenProvenanceGates(getLivePairingState(), "provenance_verified", result.remoteSha || null);
        this._updateStatus({
          provenance_gate_job_id: null,
          provenance_gate_rejected: false,
          provenance_gate_rejected_oid: null,
        });
      }
      if (result?.ok === true && this._failureRecorded) {
        // Clear a failure this poller recorded (deadline, thrown sync, bad
        // configuration); the coordinator clears its own on success.
        this._failureRecorded = false;
        try {
          this._updateStatus({ last_sync_error_code: null, last_sync_error_at: null });
        } catch { /* failure telemetry is best-effort */ }
      }
      // Peer heads are classified only against a fetch that completed; a
      // skipped (merge_in_progress) or failed sync proves nothing about them.
      if (result?.fetchCompleted === true) await this._classifyPeerHints(result, signal, assertCurrent);
      assertCurrent();
      if (result?.reason === "shared_trunk_provenance_blocked") ensureProvenanceGate(result);
      if (result?.blocked || result?.diverged || (result?.unresolved?.length || 0) > 0
        || result?.reason === "unresolved_shared_trunk_operation") {
        // Blocked recovery halts trunk writes, but its completed claim-
        // inclusive fetch is still authoritative for the advisory mirror —
        // without this the peer-claim view ages for as long as one journal
        // row stays unresolved.
        await this._reconcileClaims(result, effectiveConfig, signal);
        assertCurrent();
        await reconcileSessionDelegationCommits(this.projectDir);
        return { ...result, attempted: true, config: effectiveConfig, blocked: true };
      }
      // A held checkout did not move, so its provenance baseline must not.
      if (result?.ok && result.held !== true && TRUNK_HEAD_PATTERN.test(String(result.newSha || ""))) {
        const live = getLivePairingState();
        if (live?.phase === "active" && live.baseline_oid !== result.newSha) {
          updatePairingEnrollment(live.id, { baselineOid: result.newSha, phase: "active" });
          updateSharedTrunkRuntimeStatus({ provenance_gate_rejected: false, provenance_gate_job_id: null });
        }
      }
      await this._reconcileClaims(result, effectiveConfig, signal);
      assertCurrent();
      await reconcileSessionDelegationCommits(this.projectDir);
      return { ...result, config: effectiveConfig };
    } catch (err) {
      this._claimCursor = null;
      this._claimCycleStartedAt = null;
      // Fetch/transport is fail-open for job dispatch. The merge coordinator
      // still fails closed before any trunk write.
      this._log({
        event_type: EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Shared-trunk fetch failed; dispatch will continue: ${err?.message || err}`,
        event_json: JSON.stringify({ error: err?.message || String(err), fail_open: true }),
      });
      this._recordFailure(signal?.aborted
        ? errorCode(signal.reason?.code, "ABORT_ERR")
        : errorCode(err?.code, "shared_trunk_sync_failed"));
      return { attempted: true, unavailable: true, config, error: err };
    }
  }

  /** Abort the in-flight sync, if any (its owner is shutting down). */
  abortInFlight(reason = "Shared-trunk poll aborted by its owner") {
    this._activeController?.abort(abortError(reason));
  }

  _holdStatus() {
    try {
      const status = this._readHold({ nowMs: this._nowMs() });
      return status && typeof status === "object" ? status : { state: SESSION_HOLD_STATES.NONE, hold: null };
    } catch {
      // An unreadable hold row is advisory state: never freeze on it.
      return { state: SESSION_HOLD_STATES.NONE, hold: null };
    }
  }

  // Persist the cadence actually in effect so the sync indicator judges fetch
  // freshness against the idle or active window the scheduler is using. The
  // cadence-skip path runs every lap, so it writes only when the window
  // changes.
  _recordCadence(intervalSec, dueAtMs, { force = false, ...extra } = {}) {
    if (!force && this._recordedIntervalSec === intervalSec) return;
    this._recordedIntervalSec = intervalSec;
    try {
      this._updateStatus({
        poll_interval_sec: intervalSec,
        next_poll_due_at: Number.isFinite(dueAtMs) && dueAtMs > 0 ? new Date(dueAtMs).toISOString() : null,
        ...extra,
      });
    } catch { /* cadence telemetry is best-effort */ }
  }

  _recordFailure(code, extra = {}) {
    this._failureRecorded = true;
    try {
      this._updateStatus({
        last_sync_error_code: code,
        last_sync_error_at: new Date(this._nowMs()).toISOString(),
        ...extra,
      });
    } catch { /* failure telemetry is best-effort */ }
  }

  _peerMuted(instanceId, nowMs) {
    const until = this._mutedPeers.get(instanceId);
    if (until == null) return false;
    if (until > nowMs) return true;
    this._mutedPeers.delete(instanceId);
    return false;
  }

  _negativelyCached(head, nowMs) {
    const until = this._negativeHeads.get(head);
    if (until == null) return false;
    if (until > nowMs) return true;
    this._negativeHeads.delete(head);
    return false;
  }

  _hintedFetchDue(nowMs) {
    if (this._latestHints.length === 0) return false;
    if (this._lastHintFetchAt != null
      && nowMs - this._lastHintFetchAt < SESSION_SYNC_POLICY.HINT_FETCH_FLOOR_MS) return false;
    let status = {};
    try {
      status = this._readStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK) || {};
    } catch {
      status = {};
    }
    const known = new Set([status.remote_sha, status.local_sha].map((value) => String(value || "").toLowerCase()));
    const classified = status.peer_heads && typeof status.peer_heads === "object" ? status.peer_heads : {};
    return this._latestHints.some((hint) => (
      !this._peerMuted(hint.instance_id, nowMs)
      && !known.has(hint.trunk_head)
      && !this._triedHeads.has(hint.trunk_head)
      && !this._negativelyCached(hint.trunk_head, nowMs)
      && !Object.hasOwn(classified, hint.trunk_head)
    ));
  }

  // After a completed fetch of the shared branch, classify each advertised
  // head against the fetched origin ref with read-only object queries and
  // cache the relation per (head, origin head). Heads still absent go to the
  // negative cache; a peer advertising two such heads is muted for a while.
  async _classifyPeerHints(result, signal = null, assertCurrent = () => throwIfAborted(signal)) {
    const hints = this._latestHints;
    if (hints.length === 0) return;
    const nowMs = this._nowMs();
    try {
      const status = this._readStatus(RUNTIME_STATUS_KEYS.SHARED_TRUNK) || {};
      const remoteSha = String(result?.remoteSha || status.remote_sha || "").toLowerCase();
      if (!TRUNK_HEAD_PATTERN.test(remoteSha)) return;
      const prior = status.peer_heads && typeof status.peer_heads === "object" ? status.peer_heads : {};
      const checkedAt = new Date(nowMs).toISOString();
      const updates = {};
      const heads = [...new Set(hints.map((hint) => hint.trunk_head))]
        .slice(0, SESSION_SYNC_POLICY.HINT_HEADS_PER_POLL);
      for (const head of heads) {
        assertCurrent();
        if (this._nowMs() - nowMs > SESSION_SYNC_POLICY.HINT_CLASSIFY_BUDGET_MS) break;
        const cached = prior[head];
        if (cached?.against === remoteSha) {
          rememberBounded(this._triedHeads, head, true, SESSION_SYNC_POLICY.HINT_TRIED_MAX);
          continue;
        }
        const classified = await this._classifyHead(this.projectDir, { head, remoteSha, signal });
        assertCurrent();
        // Git could not answer: nothing is proven, so the head stays unseen.
        if (!classified?.relation) continue;
        rememberBounded(this._triedHeads, head, true, SESSION_SYNC_POLICY.HINT_TRIED_MAX);
        updates[head] = { ...classified, checked_at: checkedAt, against: remoteSha };
        if (classified.relation !== PEER_TRUNK_HEAD_RELATIONS.UNVERIFIED) continue;
        rememberBounded(
          this._negativeHeads,
          head,
          nowMs + SESSION_SYNC_POLICY.HINT_NEGATIVE_TTL_MS,
          SESSION_SYNC_POLICY.HINT_TRIED_MAX,
        );
        for (const hint of hints.filter((entry) => entry.trunk_head === head)) {
          const seen = this._peerUnverified.get(hint.instance_id) || new Set();
          seen.add(head);
          if (seen.size >= SESSION_SYNC_POLICY.PEER_MUTE_AFTER_UNVERIFIED) {
            this._peerUnverified.delete(hint.instance_id);
            rememberBounded(
              this._mutedPeers,
              hint.instance_id,
              nowMs + SESSION_SYNC_POLICY.PEER_MUTE_MS,
              SESSION_SYNC_POLICY.PEER_SNAPSHOT_MAX_PEERS,
            );
          } else {
            rememberBounded(this._peerUnverified, hint.instance_id, seen, SESSION_SYNC_POLICY.PEER_SNAPSHOT_MAX_PEERS);
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        this._updateStatus({ peer_heads: mergePeerHeadCache(prior, updates) });
      }
    } catch (error) {
      assertCurrent();
      // Hints are advisory; classification must never fail the poll.
      this._log({
        event_type: EVENT_TYPES.SHARED_TRUNK_SYNC_UNAVAILABLE,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: `Shared-trunk peer head classification failed: ${error?.message || error}`,
        event_json: JSON.stringify({ error: error?.message || String(error), fail_open: true }),
      });
    }
  }

  _provenanceContext() {
    const session = getLivePairingState();
    if (!session || session.phase !== "active") return {};
    const provenance = pairingSessionProvenance(session);
    if (!provenance) {
      throw Object.assign(new Error("Active session provenance identity is incomplete"), {
        code: "session_provenance_unavailable",
      });
    }
    return { provenance };
  }

  // Claims reconcile only against a fetch that actually completed — the
  // `fetchCompleted` stamp exists on every sync/reconcile result whose native
  // fetch succeeded (diverged and blocked outcomes included: the claim
  // snapshot they carry is real). A skipped, lock-busy, or unavailable result
  // never carries the stamp, and treating its empty list as complete would
  // wipe the durable peer-claim mirror.
  async _reconcileClaims(result, config, signal = null) {
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
        signal,
      });
      if (paginationSupported && nextCursor) {
        this._claimCursor = nextCursor;
      } else {
        this._claimCursor = null;
        this._claimCycleStartedAt = null;
      }
    } catch (err) {
      this._claimCursor = null;
      this._claimCycleStartedAt = null;
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
