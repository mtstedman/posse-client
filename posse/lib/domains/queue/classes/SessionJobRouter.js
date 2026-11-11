// Stateful session delegation owner. Packet and Git-ref operations remain in
// queue/functions/session-job-router.js so procedural consumers have one owner.

import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import {
  SESSION_COMPUTE_POLICIES,
  SESSION_JOB_PROTOCOL,
  SESSION_JOB_OFFER_TTL_MS,
  SESSION_JOB_CLAIM_TTL_MS,
} from "../../../catalog/session-sync.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { ensureBridgeInstanceId } from "../../bridge/functions/auth.js";
import { casPushSharedTrunkClaimNative } from "../../git/functions/shared-trunk-native.js";
import { getLivePairingState } from "../../pairing/functions/state.js";
import { readPairingPeerSnapshot } from "../../pairing/functions/work-items.js";
import {
  refreshWorkItemStatus,
  updateJobStatus,
  updateWorkItemStatus,
} from "../functions/queue-store.js";
import { now } from "../functions/common.js";
import {
  casRef,
  fetchNamespace,
  importPacket,
  offerSessionJob,
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
    instanceId = ensureBridgeInstanceId,
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
  }

  delayUntilDueMs() {
    const state = this._getState();
    return state?.phase === "active" && state.compute_policy !== SESSION_COMPUTE_POLICIES.EACH_MEMBER
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
  // to the queue; a claim fails like one whose executor disappeared.
  _settleEndedSessionDelegations(state) {
    const self = this._instanceId(this.projectDir);
    const liveSessionId = state?.remote_session_id || null;
    const rows = getDb().prepare(`
      SELECT * FROM work_item_delegations
      WHERE originator_instance_id = ? AND state IN ('offered','claimed')
        AND (? IS NULL OR session_id != ?)
    `).all(self, liveSessionId, liveSessionId);
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
    if (!state || state.phase !== "active" || state.compute_policy === SESSION_COMPUTE_POLICIES.EACH_MEMBER) {
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
    let imported = 0;
    let reconciled = 0;
    let importError = null;
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
          const nextState = offer.state === "succeeded" ? "running" : "failed";
          if (row.state !== nextState) {
            if (offer.state === "failed") updateJobStatus(row.origin_job_id, "failed", { expectedStatuses: ["blocked"] });
            getDb().prepare(`UPDATE work_item_delegations SET state=?, claim_oid=?, completed_at=?, updated_at=? WHERE offer_key=?`)
              .run(nextState, ref.oid, now(), now(), ref.key);
            if (offer.state === "failed") refreshWorkItemStatus(row.origin_work_item_id);
            reconciled += 1;
          }
          if (offer.state === "failed") {
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
      const packetRef = packetByKey.get(ref.key);
      if (!packetRef || packetRef.oid !== offer.packet_oid || !packetMatchesOffer(packetRef.payload, offer, self)) continue;
      let claimOid = ref.oid;
      if (!unimportedClaim) {
        const claimed = { ...offer, state: "claimed", executor_instance_id: self, claimed_at: now() };
        const claim = await casRef({
          projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
          key: ref.key, expectedOldOid: ref.oid, payload: claimed, casPush: this._casPush,
        });
        if (resultOutcome(claim) !== "applied") continue;
        claimOid = resultOid(claim);
      }
      try {
        importPacket(packetRef.payload, self, ref.key, claimOid);
        imported += 1;
      } catch (error) {
        // The claim stays ours and is retried next poll; the passes below
        // still run, then the first failure surfaces to the caller.
        importError ||= error;
      }
    }
    await this._publishCompletions(state, self, jobRefs);
    await this._recallExpiredOffers(state, jobRefs);
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
      getDb().prepare(`UPDATE work_item_delegations SET state=?, completed_at=?, updated_at=? WHERE offer_key=? AND state='imported'`)
        .run(published ? "running" : "failed", now(), now(), row.offer_key);
    }
  }

  async _recallExpiredOffers(state, refs) {
    const refsByKey = new Map(refs.map((row) => [row.key, row]));
    const cutoff = new Date(this._nowMs() - SESSION_JOB_OFFER_TTL_MS).toISOString();
    const rows = getDb().prepare(`SELECT * FROM work_item_delegations WHERE state='offered' AND created_at < ?`).all(cutoff);
    for (const row of rows) {
      const remote = refsByKey.get(row.offer_key);
      if (!remote || remote.payload?.state !== "offered") continue;
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

  async _expireOrphanedClaims(state, refs, self, snapshot) {
    const refsByKey = new Map(refs.map((row) => [row.key, row]));
    const present = new Set([self, ...(snapshot?.peers || [])
      .map((peer) => peer?.instance_id)
      .filter(Boolean)]);
    const cutoffMs = this._nowMs() - SESSION_JOB_CLAIM_TTL_MS;
    const rows = getDb().prepare(`
      SELECT * FROM work_item_delegations
      WHERE session_id=? AND originator_instance_id=? AND state='claimed'
    `).all(state.remote_session_id, self);
    let expired = 0;
    for (const row of rows) {
      const remote = refsByKey.get(row.offer_key);
      const claim = remote?.payload;
      const claimedAtMs = Date.parse(String(claim?.claimed_at || ""));
      if (claim?.state !== "claimed"
        || claim.executor_instance_id !== row.executor_instance_id
        || present.has(row.executor_instance_id)
        || !Number.isFinite(claimedAtMs)
        || claimedAtMs > cutoffMs) continue;
      const result = await casRef({
        projectDir: this.projectDir, remote: state.remote_name, namespace: "jobs",
        key: row.offer_key, expectedOldOid: remote.oid, payload: null, casPush: this._casPush,
      });
      if (resultOutcome(result) !== "applied") continue;
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
