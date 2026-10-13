import { SESSION_ADVISORY_POLICY } from "../../../catalog/session-sync.js";
import { diffPairingMembers } from "../../pairing/functions/session-console.js";

// Display/re-drive hints never gate dispatch. Each request has one owner and
// its own completion-based cadence, and old sessions cannot publish late data.
export class SessionAdvisoryRefresh {
  constructor({ nowMs = () => Date.now() } = {}) {
    this.nowMs = nowMs;
    this.reset();
  }

  reset() {
    for (const lane of Object.values(this.lanes || {})) lane.controller?.abort();
    this.generation = (this.generation || 0) + 1;
    this.key = null;
    this.lanes = { roster: {}, submissions: {} };
    this.roster = null;
    this.seenMembers = new Map();
    this.membersPrimed = false;
    this.submissionSignature = null;
    this.memberEvents = [];
    this.submissionWorkItems = new Set();
    this.submissionsChanged = false;
  }

  poll({ state, status, client, force = false }) {
    const key = JSON.stringify([
      state.id, state.remote_session_id, state.relay_token, state.role,
      status.submission_approval_enabled === true, status.submission_policy_revision,
    ]);
    if (key !== this.key) {
      this.reset();
      this.key = key;
    }
    if (status.status !== "active") {
      this.reset();
      return;
    }
    if (state.role === "host" && typeof client?.members === "function") {
      this.start(this.lanes.roster, force,
        (signal) => client.members(state.relay_token, { signal }),
        (listed) => {
          if (!Array.isArray(listed?.members)) throw new Error("Invalid session roster");
          this.roster = listed.members;
          const events = diffPairingMembers(listed.members, this.seenMembers);
          if (this.membersPrimed) this.memberEvents.push(...events);
          this.membersPrimed = true;
        });
    }
    if (status.submission_approval_enabled === true && typeof client?.teamSubmissions === "function") {
      this.start(this.lanes.submissions, force,
        (signal) => client.teamSubmissions(state.relay_token, state.remote_session_id, { signal }),
        (listing) => {
          if (listing?.contract_version !== 1 || listing.session_id !== state.remote_session_id
            || !Array.isArray(listing.submissions)) throw new Error("Invalid session submissions");
          const projection = listing.submissions
            .filter((row) => ["pending", "approved", "denied"].includes(String(row.state || "").toLowerCase()))
            .map((row) => ({
              submission_id: row.id ?? row.submission_id ?? null,
              work_item_id: row.work_item_id,
              state: row.state,
              grant_revision: row.grant_revision ?? null,
              policy_revision: row.policy_revision ?? null,
              decision_action_id: row.decision_action_id ?? null,
              decision_at: row.decision_at ?? null,
              candidate_oid: row.candidate_oid ?? null,
            }))
            .sort((left, right) => String(left.submission_id).localeCompare(String(right.submission_id)));
          const signature = JSON.stringify(projection);
          if (this.submissionSignature != null && signature !== this.submissionSignature) {
            this.submissionsChanged = true;
            for (const row of projection) {
              if (row.work_item_id && this.submissionWorkItems.size < 64) this.submissionWorkItems.add(row.work_item_id);
            }
          }
          this.submissionSignature = signature;
        });
    }
  }

  start(lane, force, request, publish) {
    if (lane.pending || (!force && this.nowMs() < (lane.dueAt || 0))) return;
    const generation = this.generation;
    const controller = new AbortController();
    lane.controller = controller;
    const current = () => this.generation === generation && !controller.signal.aborted;
    lane.pending = Promise.resolve().then(() => current() ? request(controller.signal) : null).then((result) => {
      if (!current()) return;
      publish(result);
      lane.failures = 0;
      lane.dueAt = this.nowMs() + SESSION_ADVISORY_POLICY.INTERVAL_MS;
    }).catch(() => {
      if (!current()) return;
      lane.failures = (lane.failures || 0) + 1;
      lane.dueAt = this.nowMs() + Math.min(
        SESSION_ADVISORY_POLICY.MAX_BACKOFF_MS,
        SESSION_ADVISORY_POLICY.INTERVAL_MS * (2 ** Math.min(lane.failures, 8)),
      );
    }).finally(() => {
      if (this.generation !== generation) return;
      lane.pending = null;
      lane.controller = null;
    });
  }

  takeSnapshot() {
    const snapshot = {
      roster: this.roster,
      memberEvents: this.memberEvents,
      teamSubmissionChanged: this.submissionsChanged,
      teamSubmissionWorkItemIds: [...this.submissionWorkItems],
    };
    this.memberEvents = [];
    this.submissionsChanged = false;
    this.submissionWorkItems.clear();
    return snapshot;
  }
}
