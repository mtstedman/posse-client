// Stateful session delegation owner. Packet and Git-ref operations remain in
// queue/functions/session-job-router.js so procedural consumers have one owner.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../catalog/event.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import {
  SESSION_JOB_PROTOCOL,
  SESSION_JOB_HOLD_REASONS,
  SESSION_JOB_OFFER_TTL_MS,
  SESSION_JOB_CLAIM_TTL_MS,
} from "../../../catalog/session-sync.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { casPushSharedTrunkClaimNative } from "../../git/functions/shared-trunk-native.js";
import { getLivePairingState, sessionInstanceId } from "../../pairing/functions/state.js";
import {
  acceptedComputeOwner,
  acceptsSessionOffer,
  normalizeComputeOwner,
  sessionRoutingActive,
} from "../../pairing/functions/compute-lease.js";
import { readPairingPeerSnapshot } from "../../pairing/functions/work-items.js";
import {
  getWorkItem,
  logEvent,
  refreshWorkItemStatus,
  reholdPostMergeDbTasksForWorkItem,
  setJobError,
  updateJobStatus,
  updateWorkItemStatus,
} from "../functions/queue-store.js";
import { now, runImmediateTransaction } from "../functions/common.js";
import { reopenFailedWorkItem, restoreCanceledDependents } from "../functions/work-item-recovery.js";
import {
  casRef,
  fetchNamespace,
  importPacket,
  offerSessionJob,
  sessionMustWaitForHost,
  sessionHostLacksProviderText,
  packetMatchesOffer,
  resultOid,
  SESSION_REF_FETCH_LIMIT,
  resultOutcome,
} from "../functions/session-job-router.js";

export class SessionJobRouter {
  constructor({
    projectDir = process.cwd(),
    getState = getLivePairingState,
    getSnapshot = readPairingPeerSnapshot,
    // The session row's identity, not the bridge's (see sessionInstanceId).
    instanceId = (dir) => sessionInstanceId(dir, getState()),
    casPush = casPushSharedTrunkClaimNative,
    fetchRefs = fetchNamespace,
    nowMs = () => Date.now(),
  } = {}) {
    this.projectDir = projectDir;
    this._getState = getState;
    this._getSnapshot = getSnapshot;
    this._instanceId = instanceId;
    this._casPush = casPush;
    this._fetchRefs = fetchRefs;
    this._nowMs = nowMs;
    this._nextDueAt = 0;
    this._inFlight = null;
    // offer_key -> ms an executor was first seen missing from the peer snapshot
    // while holding a claim; a claim is only orphaned after a continuous absence.
    this._claimAbsentSince = new Map();
    this._leaseFallbackLogged = new Set();
    // Claims this instance holds whose import has not landed yet. They have
    // no delegation row, so they alone keep routing on until they import.
    this._unimportedClaims = new Set();
  }

  /**
   * Routing runs while any lease in the session moves work between machines,
   * and keeps running while delegations are open so a lease that changes
   * mid-flight still settles the work it already offered or accepted.
   */
  _routingActive(state) {
    if (!state || state.phase !== "active") return false;
    if (this._unimportedClaims.size > 0) return true;
    if (sessionRoutingActive(state, [])) return true;
    // Only a host needs the peer snapshot: it executes for host-leased members.
    if (state.role === "host" && sessionRoutingActive(state, this._getSnapshot()?.peers)) return true;
    if (!state.remote_session_id) return false;
    try {
      return Boolean(getDb().prepare(`
        SELECT 1 FROM work_item_delegations
        WHERE session_id = ? AND state IN ('offered','claimed','imported')
        LIMIT 1
      `).get(state.remote_session_id));
    } catch {
      return false;
    }
  }

  delayUntilDueMs() {
    const state = this._getState();
    return this._routingActive(state)
      ? Math.max(0, this._nextDueAt - this._nowMs()) : null;
  }

  offer(job) {
    return offerSessionJob(job, {
      projectDir: this.projectDir,
      state: this._getState(),
      snapshot: this._getSnapshot(),
      instanceId: this._instanceId(this.projectDir),
      casPush: this._casPush,
    });
  }

  /**
   * The lease promises the host runs this job, and the host cannot take it now
   * (offline, no matching provider, or no headroom). The job waits; it never
   * runs on this clone. One event per job, so a job held across many laps (or
   * across restarts) records nothing more than once. A host that is here but
   * does not run the job's provider (`route` from offer) gets its own one
   * event, naming the provider and the remedies, even after a plain wait.
   */
  recordAwaitingHost(job, route = null) {
    const lacksProvider = route?.reason === SESSION_JOB_HOLD_REASONS.HOST_LACKS_PROVIDER;
    const key = lacksProvider ? `${job?.id}:${route.reason}` : job?.id;
    if (!job?.id || this._leaseFallbackLogged.has(key)) return false;
    this._leaseFallbackLogged.add(key);
    try {
      const recorded = lacksProvider
        ? getDb().prepare(`
          SELECT 1 FROM events
          WHERE job_id = ? AND event_type = ? AND json_extract(event_json, '$.reason') = ? LIMIT 1
        `).get(job.id, EVENT_TYPES.SESSION_JOB_AWAITING_HOST, route.reason)
        : getDb().prepare("SELECT 1 FROM events WHERE job_id = ? AND event_type = ? LIMIT 1")
          .get(job.id, EVENT_TYPES.SESSION_JOB_AWAITING_HOST);
      if (recorded) return false;
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.SESSION_JOB_AWAITING_HOST,
        actor_type: EVENT_ACTORS.SCHEDULER,
        ...(lacksProvider ? {
          message: `${sessionHostLacksProviderText(job, route.provider)} It waits here until one of those changes.`,
          event_json: JSON.stringify({ reason: route.reason, provider: route.provider, host_instance_id: route.hostInstanceId || null }),
        } : {
          message: `Job #${job.id} is waiting for the session host: this clone's lease names the host, `
            + "so the job never runs here. It starts when the host can take it "
            + "(the host can run `posse session lease <member-id> member` to let this clone run its own work)",
        }),
      });
      return true;
    } catch {
      return false; // the event is advisory; the hold stands
    }
  }

  /**
   * A headless run has no one to wait with: a job whose host is here but does
   * not run its provider (`route` from offer) fails with that reason, so the
   * run can end. It never runs on this clone instead.
   */
  failForMissingHostProvider(job, route) {
    if (!job?.id || route?.reason !== SESSION_JOB_HOLD_REASONS.HOST_LACKS_PROVIDER) return false;
    const reason = `${sessionHostLacksProviderText(job, route.provider)} `
      + "This run has no display to wait with, so the job failed; retry it once the host has changed.";
    try {
      if (!updateJobStatus(job.id, "failed", { expectedStatuses: ["queued"] })) return false;
      setJobError(job.id, reason);
      logEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.JOB_HEADLESS_RECOVERY,
        actor_type: EVENT_ACTORS.SCHEDULER,
        message: reason,
        event_json: JSON.stringify({ reason: route.reason, provider: route.provider, host_instance_id: route.hostInstanceId || null }),
      });
      refreshWorkItemStatus(job.work_item_id);
      return true;
    } catch {
      return false; // the job stays held for the host, as before
    }
  }

  poll({ force = false } = {}) {
    if (this._inFlight) return this._inFlight;
    const run = this._pollOnce({ force });
    const tracked = run.finally(() => { if (this._inFlight === tracked) this._inFlight = null; });
    this._inFlight = tracked;
    return tracked;
  }

  // Delegations this instance originated in a session that is no longer the
  // live one can never be recalled, completed or expired through the session
  // refs: every pass below runs only for the live, routing session. Their
  // origin jobs would stay blocked with no gate. An unclaimed offer returns
  // to the queue; a claim fails like one whose executor disappeared. Only an
  // originator writes these states (an import starts at 'imported'), so they
  // are matched without this clone's identity: the one it held in that
  // session is not today's bridge identity once a phone pairing replaced it.
  _settleEndedSessionDelegations(state) {
    const liveSessionId = state?.remote_session_id || null;
    const rows = getDb().prepare(`
      SELECT * FROM work_item_delegations
      WHERE state IN ('offered','claimed')
        AND (? IS NULL OR session_id != ?)
    `).all(liveSessionId, liveSessionId);
    for (const row of rows) {
      if (row.state === "offered") {
        getDb().prepare(`UPDATE work_item_delegations SET state='recalled', updated_at=? WHERE offer_key=? AND state='offered'`)
          .run(now(), row.offer_key);
        if (updateJobStatus(row.origin_job_id, "queued", { expectedStatuses: ["blocked"] })) {
          updateWorkItemStatus(row.origin_work_item_id, "running");
        }
      } else {
        getDb().prepare(`
          UPDATE work_item_delegations
          SET state='failed', completed_at=?, updated_at=?
          WHERE offer_key=? AND state='claimed'
        `).run(now(), now(), row.offer_key);
        updateJobStatus(row.origin_job_id, "failed", { expectedStatuses: ["blocked"] });
        refreshWorkItemStatus(row.origin_work_item_id);
      }
    }
    return rows.length;
  }

  async _pollOnce({ force }) {
    const state = this._getState();
    this._settleEndedSessionDelegations(state);
    if (!this._routingActive(state)) {
      return { attempted: false, skipped: "routing_disabled" };
    }
    if (!force && this._nowMs() < this._nextDueAt) return { attempted: false, skipped: "cadence" };
    this._nextDueAt = this._nowMs() + 5_000;
    const self = this._instanceId(this.projectDir);
    const snapshot = this._getSnapshot();
    let jobRefs;
    let packets;
    try {
      jobRefs = await this._fetchRefs(this.projectDir, state.remote_name, "jobs");
      packets = await this._fetchRefs(this.projectDir, state.remote_name, "handoff");
    } catch (error) {
      return { attempted: true, unavailable: true, error };
    }
    const packetByKey = new Map(packets.map((row) => [row.key, row]));
    const peerByInstance = new Map((snapshot?.peers || [])
      .filter((peer) => peer?.instance_id)
      .map((peer) => [peer.instance_id, peer]));
    let imported = 0;
    let reconciled = 0;
    let importError = null;
    const unimportedClaims = new Set();
    for (const ref of jobRefs) {
      const offer = ref.payload;
      if (offer?.protocol !== SESSION_JOB_PROTOCOL || offer.session_id !== state.remote_session_id) continue;
      if (offer.originator_instance_id === self) {
        const row = getDb().prepare("SELECT * FROM work_item_delegations WHERE offer_key = ?").get(ref.key);
        if (!row) continue;
        if (offer.state === "claimed" && row.state === "offered") {
          getDb().prepare(`UPDATE work_item_delegations SET state='claimed', executor_instance_id=?, claim_oid=?, updated_at=? WHERE offer_key=?`)
            .run(offer.executor_instance_id, ref.oid, now(), ref.key);
          reconciled += 1;
        } else if (["succeeded", "failed"].includes(offer.state)) {
          // A success for a delegation already failed here is taken back only
          // when the recovery succeeds. When it is refused, the failure stands
          // and nothing waits for the executor's merge, so the delegation is
          // settled failed (and its refs deleted) instead of left running for
          // a trunk trailer that can no longer settle it. A recovery that
          // could not run (null) is retried on the next poll.
          let failed = offer.state === "failed";
          if (offer.state === "succeeded" && row.state === "failed") {
            const recovered = this._recoverFalselyFailedOrigin(row);
            if (recovered == null) continue;
            failed = !recovered;
          }
          const nextState = failed ? "failed" : "running";
          if (row.state !== nextState) {
            if (offer.state === "failed") updateJobStatus(row.origin_job_id, "failed", { expectedStatuses: ["blocked"] });
            getDb().prepare(`UPDATE work_item_delegations SET state=?, claim_oid=?, completed_at=?, updated_at=? WHERE offer_key=?`)
              .run(nextState, ref.oid, now(), now(), ref.key);
            if (offer.state === "failed") refreshWorkItemStatus(row.origin_work_item_id);
            reconciled += 1;
          }
          if (failed) {
            try {
              await casRef({
                projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
                key: row.offer_key, expectedOldOid: ref.oid, payload: null, casPush: this._casPush,
              });
              await casRef({
                projectDir: this.projectDir, remote: state.remote_name, namespace: "handoff",
                key: row.offer_key, expectedOldOid: row.packet_oid, payload: null, casPush: this._casPush,
              });
            } catch { /* terminal ref cleanup is recoverable on a later maintenance pass */ }
          }
        }
        continue;
      }
      // A claim this instance already won but never imported (the import threw
      // or the process died between the CAS and the local write) is still
      // importable: nobody else can take it and the originator only expires
      // claims of absent executors.
      const unimportedClaim = offer.state === "claimed" && offer.executor_instance_id === self
        && !getDb().prepare("SELECT 1 FROM work_item_delegations WHERE offer_key = ?").get(ref.key);
      if ((offer.state !== "offered" && !unimportedClaim) || !offer.eligible_instance_ids?.includes(self)) continue;
      // The issuer's lease decides who pays. Claim only work whose originator
      // the Remote reports under a lease that names this clone's role. A claim
      // already won was accepted under the lease of that moment: it is still
      // imported when the lease has changed or the originator has left the
      // snapshot, or the origin job would stay blocked behind a held claim.
      const originator = peerByInstance.get(offer.originator_instance_id);
      if (!unimportedClaim && !acceptsSessionOffer(state, originator)) continue;
      const packetRef = packetByKey.get(ref.key);
      if (!packetRef || packetRef.oid !== offer.packet_oid || !packetMatchesOffer(packetRef.payload, offer, self)) continue;
      let claimOid = ref.oid;
      // The claim carries the lease it was accepted under, so a re-import
      // records that lease. A claim written before leases has none.
      let computeOwner = normalizeComputeOwner(offer.compute_owner) || acceptedComputeOwner(state, originator);
      if (!unimportedClaim) {
        computeOwner = acceptedComputeOwner(state, originator);
        const claimed = {
          ...offer, state: "claimed", executor_instance_id: self, claimed_at: now(), compute_owner: computeOwner,
        };
        const claim = await casRef({
          projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
          key: ref.key, expectedOldOid: ref.oid, payload: claimed, casPush: this._casPush,
        });
        if (resultOutcome(claim) !== "applied") continue;
        claimOid = resultOid(claim);
      }
      try {
        importPacket(packetRef.payload, self, ref.key, claimOid, { computeOwner });
        imported += 1;
      } catch (error) {
        // The claim stays ours and is retried next poll; the passes below
        // still run, then the first failure surfaces to the caller.
        importError ||= error;
        unimportedClaims.add(ref.key);
      }
    }
    this._unimportedClaims = unimportedClaims;
    await this._publishCompletions(state, self, jobRefs);
    await this._recallExpiredOffers(state, jobRefs, snapshot);
    const expiredClaims = await this._expireOrphanedClaims(state, jobRefs, self, snapshot);
    if (importError) throw importError;
    return { attempted: true, imported, reconciled, expiredClaims };
  }

  async _publishCompletions(state, self, refs = []) {
    const refsByKey = new Map(refs.map((row) => [row.key, row]));
    const terminalPlaceholders = TERMINAL_JOB_STATUSES.map(() => "?").join(",");
    const rows = getDb().prepare(`
      SELECT d.*, j.status AS job_status
      FROM work_item_delegations d JOIN jobs j ON j.id=d.local_job_id
      WHERE d.executor_instance_id=? AND d.state='imported'
        AND j.status IN (${terminalPlaceholders})
    `).all(self, ...TERMINAL_JOB_STATUSES);
    for (const row of rows) {
      const payload = {
        protocol: SESSION_JOB_PROTOCOL,
        state: row.job_status === "succeeded" ? "succeeded" : "failed",
        session_id: row.session_id,
        offer_key: row.offer_key,
        originator_instance_id: row.originator_instance_id,
        origin_work_item_id: row.origin_work_item_id,
        origin_job_id: row.origin_job_id,
        executor_instance_id: self,
        completed_at: now(),
      };
      let result = null;
      try {
        result = await casRef({
          projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
          key: row.offer_key, expectedOldOid: row.claim_oid, payload, casPush: this._casPush,
        });
      } catch { /* decided below from the fetched refs; one row never aborts the later passes */ }
      if (resultOutcome(result) === "applied") {
        getDb().prepare(`UPDATE work_item_delegations SET state=?, claim_oid=?, completed_at=?, updated_at=? WHERE offer_key=?`)
          .run(payload.state === "succeeded" ? "running" : "failed", resultOid(result), now(), now(), row.offer_key);
        continue;
      }
      // Only the originator replaces a claimed ref (it expires the claim of an
      // absent executor), so a lost CAS, or a fetched view in which the ref is
      // gone or is not this claim, means the completion can never be
      // published. Settle the row instead of retrying the CAS every poll.
      const remote = refsByKey.get(row.offer_key)?.payload;
      const claimHeld = remote?.state === "claimed" && remote.executor_instance_id === self;
      if (resultOutcome(result) !== "lost_race" && (claimHeld || (!remote && refs.length >= SESSION_REF_FETCH_LIMIT))) continue;
      // A completion this executor already published (local write lost) keeps its outcome.
      const published = remote?.executor_instance_id === self && remote.state === "succeeded";
      // The originator expired this claim while the job ran, but the job
      // finished. Publish the success again under the vacated key so the
      // originator can take back its false failure instead of replanning
      // work that is already done. Only from a complete fetch that shows the
      // ref gone; any other state is the originator's decision.
      if (!published && payload.state === "succeeded" && !remote && refs.length < SESSION_REF_FETCH_LIMIT) {
        let republished = null;
        try {
          republished = await casRef({
            projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
            key: row.offer_key, expectedOldOid: null, payload, casPush: this._casPush,
          });
        } catch { /* settled as failed below, as before */ }
        if (resultOutcome(republished) === "applied") {
          getDb().prepare(`UPDATE work_item_delegations SET state='running', claim_oid=?, completed_at=?, updated_at=? WHERE offer_key=? AND state='imported'`)
            .run(resultOid(republished), now(), now(), row.offer_key);
          continue;
        }
      }
      getDb().prepare(`UPDATE work_item_delegations SET state=?, completed_at=?, updated_at=? WHERE offer_key=? AND state='imported'`)
        .run(published ? "running" : "failed", now(), now(), row.offer_key);
    }
  }

  // An offer whose job a host lease promises to the host stands for as long as
  // an eligible executor is in the session (or the peer snapshot is unknown):
  // withdrawing and re-sending it every TTL only churned the session repo and
  // flipped the job between blocked and queued while the host's scheduler was
  // not running yet. It is withdrawn once no eligible executor remains.
  _offerStandsForPresentHost(state, row, offer, snapshot) {
    let job = null;
    try { job = getDb().prepare("SELECT * FROM jobs WHERE id=?").get(row.origin_job_id); } catch { return false; }
    if (!job || !sessionMustWaitForHost(state, job)) return false;
    if (!snapshot || !Array.isArray(snapshot.peers)) return true;
    const present = new Set(snapshot.peers.map((peer) => peer?.instance_id).filter(Boolean));
    const eligible = Array.isArray(offer?.eligible_instance_ids) ? offer.eligible_instance_ids : [];
    return eligible.some((id) => present.has(id));
  }

  async _recallExpiredOffers(state, refs, snapshot = null) {
    const refsByKey = new Map(refs.map((row) => [row.key, row]));
    const cutoff = new Date(this._nowMs() - SESSION_JOB_OFFER_TTL_MS).toISOString();
    const rows = getDb().prepare(`SELECT * FROM work_item_delegations WHERE state='offered' AND created_at < ?`).all(cutoff);
    for (const row of rows) {
      const remote = refsByKey.get(row.offer_key);
      if (!remote || remote.payload?.state !== "offered") continue;
      if (this._offerStandsForPresentHost(state, row, remote.payload, snapshot)) continue;
      const result = await casRef({
        projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
        key: row.offer_key, expectedOldOid: remote.oid, payload: null, casPush: this._casPush,
      });
      if (resultOutcome(result) !== "applied") continue;
      getDb().prepare(`UPDATE work_item_delegations SET state='recalled', updated_at=? WHERE offer_key=?`).run(now(), row.offer_key);
      if (updateJobStatus(row.origin_job_id, "queued", { expectedStatuses: ["blocked"] })) {
        updateWorkItemStatus(row.origin_work_item_id, "running");
      }
      try {
        await casRef({
          projectDir: this.projectDir, remote: state.remote_name, namespace: "handoff",
          key: row.offer_key, expectedOldOid: row.packet_oid, payload: null, casPush: this._casPush,
        });
      } catch { /* an orphaned packet cannot be claimed without its offer */ }
    }
  }

  // The executor finished a job this instance had already failed (its claim
  // was expired while the job ran). Take the failure back only while nothing
  // has acted on it: the origin job is still failed, its work item is failed
  // or still open (not canceled or complete), and no recovery replan has been
  // created for the work item. The job returns to waiting on the executor's
  // merge, which the trunk trailer settles (session-job-router.js
  // reconcileSessionDelegationCommits); the executor's job ending is not that
  // merge. What the failure canceled is brought back, and a failed work item
  // reopens so its recovery gate retires. Returns true when the failure was
  // withdrawn, false when it stands, and null when the recovery could not run.
  _recoverFalselyFailedOrigin(row) {
    try {
      return runImmediateTransaction(getDb(), () => {
        const replanned = getDb().prepare(`
          SELECT 1 FROM jobs
          WHERE work_item_id=? AND id>? AND payload_json LIKE '%replan_after_failure_recovery%' LIMIT 1
        `).get(row.origin_work_item_id, row.origin_job_id);
        if (replanned) return false;
        const workItem = getWorkItem(row.origin_work_item_id);
        if (!workItem || (TERMINAL_WORK_ITEM_STATUSES.includes(workItem.status) && workItem.status !== "failed")) return false;
        if (!updateJobStatus(row.origin_job_id, "blocked", { expectedStatuses: ["failed"] })) return false;
        const { restored } = restoreCanceledDependents(row.origin_work_item_id, [row.origin_job_id], {
          ts: now(), gateJobId: null, supersededGates: [], restoreHeldDependents: false,
        });
        // The work item's failure canceled the database tasks held for its
        // merge; they are held for it again, as a retry does.
        const reheld = workItem.status === "failed" ? reholdPostMergeDbTasksForWorkItem(row.origin_work_item_id) : [];
        if (workItem.status === "failed") {
          reopenFailedWorkItem(row.origin_work_item_id, "blocked", "session executor finished the job");
        }
        refreshWorkItemStatus(row.origin_work_item_id);
        logEvent({
          work_item_id: row.origin_work_item_id,
          job_id: row.origin_job_id,
          event_type: EVENT_TYPES.SESSION_JOB_RECOVERED,
          actor_type: EVENT_ACTORS.SCHEDULER,
          message: `Job #${row.origin_job_id} did not fail: its executor finished it after the claim was expired; `
            + `the failure was withdrawn and the job waits for the executor's merge`
            + (restored.length > 0 ? `; restored ${restored.map((job) => `#${job.id}`).join(", ")}` : "")
            + (reheld.length > 0 ? `; held database task(s) ${reheld.map((id) => `#${id}`).join(", ")} for the merge again` : ""),
        });
        return true;
      });
    } catch {
      return null; // recovery is best effort; the failure stands until a later poll recovers it
    }
  }

  async _expireOrphanedClaims(state, refs, self, snapshot) {
    // An unavailable or stale peer snapshot says nothing about who is present:
    // treating it as "everyone is gone" expired live claims (a plan that runs
    // longer than the claim TTL was failed while its executor was working).
    if (!snapshot || !Array.isArray(snapshot.peers)) {
      this._claimAbsentSince.clear();
      return 0;
    }
    const refsByKey = new Map(refs.map((row) => [row.key, row]));
    const present = new Set([self, ...snapshot.peers
      .map((peer) => peer?.instance_id)
      .filter(Boolean)]);
    const nowMs = this._nowMs();
    const cutoffMs = nowMs - SESSION_JOB_CLAIM_TTL_MS;
    const rows = getDb().prepare(`
      SELECT * FROM work_item_delegations
      WHERE session_id=? AND originator_instance_id=? AND state='claimed'
    `).all(state.remote_session_id, self);
    const heldKeys = new Set(rows.map((row) => row.offer_key));
    for (const key of this._claimAbsentSince.keys()) {
      if (!heldKeys.has(key)) this._claimAbsentSince.delete(key);
    }
    let expired = 0;
    for (const row of rows) {
      const remote = refsByKey.get(row.offer_key);
      const claim = remote?.payload;
      const claimedAtMs = Date.parse(String(claim?.claimed_at || ""));
      if (claim?.state !== "claimed"
        || claim.executor_instance_id !== row.executor_instance_id
        || present.has(row.executor_instance_id)) {
        this._claimAbsentSince.delete(row.offer_key);
        continue;
      }
      // Claim age is not liveness: require the executor to stay missing for a
      // full TTL window, observed continuously, before failing its job.
      if (!this._claimAbsentSince.has(row.offer_key)) this._claimAbsentSince.set(row.offer_key, nowMs);
      if (!Number.isFinite(claimedAtMs)
        || claimedAtMs > cutoffMs
        || nowMs - this._claimAbsentSince.get(row.offer_key) < SESSION_JOB_CLAIM_TTL_MS) continue;
      const result = await casRef({
        projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
        key: row.offer_key, expectedOldOid: remote.oid, payload: null, casPush: this._casPush,
      });
      if (resultOutcome(result) !== "applied") continue;
      this._claimAbsentSince.delete(row.offer_key);
      getDb().prepare(`
        UPDATE work_item_delegations
        SET state='failed', completed_at=?, updated_at=?
        WHERE offer_key=? AND state='claimed'
      `).run(now(), now(), row.offer_key);
      updateJobStatus(row.origin_job_id, "failed", { expectedStatuses: ["blocked"] });
      refreshWorkItemStatus(row.origin_work_item_id);
      if (row.packet_oid) {
        try {
          await casRef({
            projectDir: this.projectDir, remote: state.remote_name, namespace: "handoff",
            key: row.offer_key, expectedOldOid: row.packet_oid, payload: null, casPush: this._casPush,
          });
        } catch { /* the authoritative claim is gone; packet cleanup is best effort */ }
      }
      expired += 1;
    }
    return expired;
  }
}

export function createSessionJobRouter(options = {}) {
  return new SessionJobRouter(options);
}
