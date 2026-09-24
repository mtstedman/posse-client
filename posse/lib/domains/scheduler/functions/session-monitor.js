// Scheduler-owned shared-session heartbeat collaborator. It deliberately owns
// no terminal input: the run TUI is the sole raw-stdin owner, while this class
// keeps membership, scope revocation, presence, and close/drain transitions
// current from inside the scheduler loop.

import { pulseTokenManager } from "../../../shared/native/classes/PulseTokenManager.js";
import { ensureBridgeInstanceId } from "../../bridge/functions/auth.js";
import { repositoryFingerprint } from "../../pairing/functions/git.js";
import { getSharedTrunkNativeCapabilities } from "../../git/functions/shared-trunk-native.js";
import {
  createPairingRemoteClient,
  validatePairingRemoteResponse,
} from "../../pairing/functions/remote-client.js";
import {
  adoptPairingProcess,
  getLivePairingState,
  touchPairingState,
  updatePairingEnrollment,
} from "../../pairing/functions/state.js";
import {
  teamPolicyRegression,
  teamPolicyRegressionMessage,
} from "../../pairing/functions/team-policy.js";
import {
  clearPairingPeerSnapshot,
  collectPairingPresence,
  writePairingPeerSnapshot,
} from "../../pairing/functions/work-items.js";

export const SESSION_HEARTBEAT_MS = 5_000;

function sessionChanged(message) {
  return Object.assign(new Error(message), { code: "pairing_session_changed" });
}

function assertStatusMatches(state, status) {
  if (status.session_id !== state.remote_session_id || status.role !== state.role) {
    throw sessionChanged("Session relay credential resolved to a different session");
  }
  let actualFingerprint;
  try {
    actualFingerprint = repositoryFingerprint(status.repository?.url);
  } catch {
    throw sessionChanged("Session repository metadata is invalid");
  }
  if (actualFingerprint !== repositoryFingerprint(state.remote_url)
    || String(status.repository?.fingerprint || "").toLowerCase() !== actualFingerprint
    || String(status.repository?.branch || "") !== state.shared_branch) {
    throw sessionChanged("Session repository metadata changed while connected");
  }
}

export class SessionMonitor {
  constructor({
    projectDir = process.cwd(),
    nowMs = () => Date.now(),
    getState = getLivePairingState,
    createClient = createPairingRemoteClient,
    collectPresence = collectPairingPresence,
    heartbeat = null,
    validate = validatePairingRemoteResponse,
    updateEnrollment = updatePairingEnrollment,
    touch = touchPairingState,
    adoptProcess = adoptPairingProcess,
    writePeers = writePairingPeerSnapshot,
    clearPeers = clearPairingPeerSnapshot,
    tokenManager = pulseTokenManager,
    capabilityCheck = getSharedTrunkNativeCapabilities,
  } = {}) {
    this.projectDir = projectDir;
    this._nowMs = nowMs;
    this._getState = getState;
    this._createClient = createClient;
    this._collectPresence = collectPresence;
    this._heartbeat = heartbeat;
    this._validate = validate;
    this._updateEnrollment = updateEnrollment;
    this._touch = touch;
    this._adoptProcess = adoptProcess;
    this._writePeers = writePeers;
    this._clearPeers = clearPeers;
    this._tokenManager = tokenManager;
    this._capabilityCheck = capabilityCheck;
    this._nextDueAt = 0;
    this._client = null;
    this._stateId = null;
    this._inFlight = null;
    this._consecutiveFailures = 0;
    this._lastStatus = null;
    this._unavailable = false;
    this._scopeCapabilityConfirmed = null;
    this._teamSubmissionSignature = null;
  }

  delayUntilDueMs() {
    const state = this._getState();
    if (!state || state.phase !== "active") return null;
    return Math.max(0, this._nextDueAt - this._nowMs());
  }

  currentStatus() {
    return this._lastStatus;
  }

  poll({ force = false } = {}) {
    if (this._inFlight) return this._inFlight;
    const run = this._pollOnce({ force });
    const tracked = run.finally(() => {
      if (this._inFlight === tracked) this._inFlight = null;
    });
    this._inFlight = tracked;
    return tracked;
  }

  async _pollOnce({ force }) {
    const state = this._getState();
    if (!state || state.phase !== "active" || !state.relay_token) {
      this._lastStatus = null;
      this._unavailable = false;
      this._nextDueAt = 0;
      this._client = null;
      this._stateId = null;
      this._consecutiveFailures = 0;
      this._scopeCapabilityConfirmed = null;
      this._teamSubmissionSignature = null;
      this._tokenManager.setSessionContext(null);
      this._clearPeers();
      return { attempted: false, skipped: "no_active_session" };
    }
    const now = this._nowMs();
    if (!force && now < this._nextDueAt) {
      return { attempted: false, skipped: "cadence", status: this._lastStatus, unavailable: this._unavailable };
    }
    this._nextDueAt = now + SESSION_HEARTBEAT_MS;
    if (this._stateId !== state.id) {
      this._client = null;
      this._stateId = state.id;
      this._consecutiveFailures = 0;
      this._scopeCapabilityConfirmed = null;
      this._teamSubmissionSignature = null;
      this._adoptProcess(state.id, process.pid);
    }
    const instanceId = state.instance_id || ensureBridgeInstanceId(this.projectDir);
    if (!state.instance_id) this._updateEnrollment(state.id, { instanceId, phase: "active" });
    this._tokenManager.setSessionContext({
      instanceId,
      sessionId: state.remote_session_id,
      requireWorkItemGrant: state.submission_approval_enabled === 1,
    });
    try {
      if (this._scopeCapabilityConfirmed == null) {
        const capabilities = await this._capabilityCheck(this.projectDir);
        this._scopeCapabilityConfirmed = capabilities?.available === true
          && capabilities.result?.scopeEnforcement === true;
        this._tokenManager.confirmNativeScopeEnforcement(this._scopeCapabilityConfirmed);
      }
      this._client ||= this._createClient();
      const raw = this._heartbeat
        ? await this._heartbeat(state, this._collectPresence(this.projectDir))
        : await this._client.heartbeat(state.relay_token, this._collectPresence(this.projectDir));
      const status = this._validate("heartbeat", raw);
      assertStatusMatches(state, status);
      const priorPolicyRevision = Number(state.submission_approval_revision) || 0;
      const policyRegression = teamPolicyRegression(state, status);
      if (policyRegression) {
        throw sessionChanged(teamPolicyRegressionMessage(policyRegression));
      }
      const teamPolicyEnabled = status.submission_approval_enabled === true;
      this._tokenManager.setSessionContext({
        instanceId,
        sessionId: state.remote_session_id,
        requireWorkItemGrant: teamPolicyEnabled,
      });
      // Changing the policy changes the pulse cache key and clears the native
      // scope proof, even when the same binary was verified earlier this run.
      this._tokenManager.confirmNativeScopeEnforcement(this._scopeCapabilityConfirmed);
      let teamSubmissionChanged = false;
      let teamSubmissionWorkItemIds = [];
      if (teamPolicyEnabled && typeof this._client?.teamSubmissions === "function") {
        try {
          const listing = await this._client.teamSubmissions(state.relay_token, state.remote_session_id);
          if (listing?.contract_version === 1 && listing.session_id === state.remote_session_id
            && Array.isArray(listing.submissions)) {
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
            teamSubmissionChanged = this._teamSubmissionSignature != null
              && signature !== this._teamSubmissionSignature;
            if (teamSubmissionChanged) {
              teamSubmissionWorkItemIds = projection.map((row) => row.work_item_id).filter(Boolean).slice(0, 64);
            }
            this._teamSubmissionSignature = signature;
          }
        } catch { /* A re-drive hint must not turn a healthy heartbeat fatal. */ }
      } else {
        this._teamSubmissionSignature = null;
      }
      const roster = state.role === "host"
        ? await this._client?.members?.(state.relay_token)
        : null;
      const nextScope = status.scope_set || {};
      const scopeChanged = JSON.stringify(nextScope) !== JSON.stringify(state.scopeSet || {});
      this._updateEnrollment(state.id, {
        phase: "active",
        scopeSet: nextScope,
        computePolicy: status.compute_policy,
        integrationPolicy: status.integration_policy,
        enrollmentOpen: status.enrollment_open,
        submissionApprovalEnabled: status.submission_approval_enabled ?? null,
        submissionPolicyRevision: status.submission_policy_revision ?? null,
        // The publication gate compares these against Remote on every merge;
        // a host mode change after scheduler handoff was otherwise never
        // learned by scheduler-driven members.
        ...(status.team_publication_mode != null ? { teamPublicationMode: status.team_publication_mode } : {}),
        ...(Number.isSafeInteger(status.team_publication_revision) ? { teamPublicationRevision: status.team_publication_revision } : {}),
      });
      const publicationChanged = (status.team_publication_mode != null && status.team_publication_mode !== state.team_publication_mode)
        || (Number.isSafeInteger(status.team_publication_revision)
          && status.team_publication_revision !== (Number(state.team_publication_revision) || 0));
      // A relay that omits the policy revision leaves the local value in
      // place, so an omitted field is not a change; comparing it against the
      // coerced local number would clear authentication on every poll.
      const policyRevisionChanged = status.submission_policy_revision != null
        && status.submission_policy_revision !== priorPolicyRevision;
      if (scopeChanged || teamPolicyEnabled !== (state.submission_approval_enabled === 1)
          || policyRevisionChanged || publicationChanged) {
        this._tokenManager.clearAuthentication();
        const { invalidateVerifiedTeamGrantCache } = await import("../../pairing/functions/team-submissions.js");
        invalidateVerifiedTeamGrantCache();
      }
      this._touch(state.id);
      const projectedStatus = roster ? { ...status, members: roster.members || [] } : status;
      this._writePeers(projectedStatus);
      this._lastStatus = projectedStatus;
      this._consecutiveFailures = 0;
      this._unavailable = false;
      return {
        attempted: true,
        status: projectedStatus,
        teamSubmissionChanged,
        teamSubmissionWorkItemIds,
        requestsDrain: status.status !== "active",
      };
    } catch (error) {
      this._consecutiveFailures += 1;
      this._unavailable = true;
      if ([401, 403].includes(Number(error?.status)) || error?.code === "pairing_session_changed") {
        this._tokenManager.clearAuthentication();
      }
      return {
        attempted: true,
        unavailable: true,
        fatal: [401, 403].includes(Number(error?.status)) || error?.code === "pairing_session_changed",
        error,
      };
    }
  }

  stop() {
    this._client = null;
    this._stateId = null;
    this._lastStatus = null;
    this._unavailable = false;
    this._scopeCapabilityConfirmed = null;
    this._tokenManager.setSessionContext(null);
    this._clearPeers();
  }
}

export function createSessionMonitor(options = {}) {
  return new SessionMonitor(options);
}
