import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import { adminGitExec } from "../../git/functions/admin-git.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { createPairingRemoteClient } from "./remote-client.js";
import { repositoryFingerprint } from "./git.js";
import { githubRepositoryName } from "./github-session.js";
import { findTeamPullRequest, verifyProtectedTeamBranch, verifyPublishedTeamPullRequest } from "./github-team-pr.js";
import { verifyTeamGrantToken } from "./team-grant-token.js";
import { loadOrCreateTeamSigningKey, newTeamGrantJti, signTeamGrantClaims } from "./team-signing-key.js";
import { cleanScopePath, verifyTeamGitScope } from "./team-scope.js";
import {
  TEAM_FAILURE_REASONS,
  TEAM_GRANT_REPAIRABLE_REASONS,
  TEAM_SCOPE_LABEL_PATTERN,
  TEAM_SCOPE_LIMITS,
} from "../../../catalog/team.js";
import { readPairingPromotionJournal } from "./promotion.js";
import { getLivePairingState, updatePairingEnrollment } from "./state.js";
import { teamPolicyRegression } from "./team-policy.js";
import { readPairingPeerSnapshot } from "./work-items.js";

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const TEAM_REF_RE = /^refs\/heads\/posse\/team\/[A-Za-z0-9._/-]{1,160}$/u;
const MAX_TEAM_RECORDS = 100;
const MAX_VERIFIED_GRANT_CACHE_MS = 60_000;
// Approval mode admits only mediated OpenAI/Grok file tools. Other provider,
// shell, image, DB, ATLAS and custom mutation routes fail closed at dispatch.
const MANAGED_FILE_WRITE_BOUNDARY_READY = true;
const verifiedGrantCache = new Map();

function fail(reason, message = null) {
  return { ok: false, reason, ...(message ? { message: String(message).slice(0, 240) } : {}) };
}

function git(args, projectDir, options = {}) {
  return adminGitExec(args, projectDir, { timeoutMs: 60_000, ...options });
}

function activeState(projectDir) {
  const state = getLivePairingState();
  if (!state || state.phase !== "active" || !state.remote_session_id || !state.relay_token || !state.instance_id) {
    return null;
  }
  if (path.resolve(projectDir) !== path.resolve(git(["rev-parse", "--show-toplevel"], projectDir))) return null;
  return state;
}

function teamWorkItemId(state, localWorkItemId, db = getDb()) {
  const localId = Number(localWorkItemId);
  if (!Number.isSafeInteger(localId) || localId <= 0) return null;
  const delegated = db.prepare(`
    SELECT DISTINCT originator_instance_id, origin_work_item_id
    FROM work_item_delegations
    WHERE session_id = ? AND local_work_item_id = ?
    LIMIT 2
  `).all(state.remote_session_id, localId);
  if (delegated.length > 1) return null;
  return delegated.length === 1
    ? `${delegated[0].originator_instance_id}:${delegated[0].origin_work_item_id}`
    : `${state.instance_id}:${localId}`;
}

// A pending Remote request has no originator binding yet. The host may only
// supply one when its own delegation ledger proves the exact WI and executor.
function provenOriginatorForGrant(state, grant, db = getDb()) {
  if (typeof grant?.work_item_id !== "string" || typeof grant?.executor_instance_id !== "string") return null;
  const separator = grant.work_item_id.lastIndexOf(":");
  const localId = Number(grant.work_item_id.slice(separator + 1));
  if (separator > 0 && Number.isSafeInteger(localId) && localId > 0
    && grant.work_item_id === `${grant.executor_instance_id}:${localId}`) {
    // A member's independent WI is self-originated: Remote authenticated the
    // executor that filed this request, so the identity is not host-supplied.
    return grant.originator_instance_id && grant.originator_instance_id !== grant.executor_instance_id
      ? null : grant.executor_instance_id;
  }
  const rows = db.prepare(`
    SELECT DISTINCT originator_instance_id
    FROM work_item_delegations
    WHERE session_id = ? AND executor_instance_id = ?
      AND originator_instance_id || ':' || origin_work_item_id = ?
    LIMIT 2
  `).all(state.remote_session_id, grant.executor_instance_id, grant.work_item_id);
  if (rows.length !== 1 || !rows[0].originator_instance_id) return null;
  if (grant.originator_instance_id && grant.originator_instance_id !== rows[0].originator_instance_id) return null;
  return rows[0].originator_instance_id;
}

function requireGrant(response, workItemId, state) {
  if (response?.contract_version !== 1 || response.session_id !== state.remote_session_id
    || !Array.isArray(response.grants) || response.grants.length > MAX_TEAM_RECORDS) {
    return fail("invalid_grant_response");
  }
  const grant = response.grants.find((row) => row?.work_item_id === workItemId);
  if (!grant) return fail("team_grant_missing");
  if (grant.executor_instance_id !== state.instance_id
    || !Number.isSafeInteger(grant.revision) || grant.revision <= 0
    || !Number.isSafeInteger(grant.claim_generation) || grant.claim_generation < 0
    || !Number.isSafeInteger(grant.policy_revision)
    || grant.policy_revision !== Number(state.submission_approval_revision)) {
    return fail("invalid_grant_response");
  }
  if (grant.state !== "active") return fail(grant.state === "waiting_for_files" ? "waiting_for_files" : "team_grant_inactive");
  const signature = verifyTeamGrantToken(grant, {
    sessionId: state.remote_session_id,
    instanceId: state.instance_id,
    repositoryFingerprint: repositoryFingerprint(state.remote_url),
    branch: state.shared_branch,
    workItemId,
    signingPublicKey: response.signing_public_key || grant.signing_public_key,
    kid: response.kid || grant.kid,
  });
  return signature.ok ? { ok: true, grant, claims: signature.claims } : signature;
}

/** Re-resolve a grant against authoritative Remote state exactly once, then
 * verify again.
 *
 * A grant is verified by comparing its signed claims against local session
 * state — shared branch, repository fingerprint, policy revision — and against
 * the locally held grant record. A stale local view therefore fails
 * verification even when the signed material is perfectly good, and that is the
 * ordinary case: the host reissued, the policy revision moved, or this clone
 * has not caught up yet. Repair that deterministically before treating any
 * failure as a security event.
 *
 * This refreshes only the inputs. Verification itself is unchanged and runs
 * again in full, so a grant that genuinely does not verify still fails; it just
 * fails with the stale-view explanation ruled out. Exactly one attempt, no
 * backoff and no loop: either the refreshed state verifies, or the failure is
 * confirmed, or the repair could not run and nothing is concluded.
 *
 * @returns the verified grant with `repaired`, a confirmed failure, or
 * `signed_grant_unconfirmed` when the repair itself could not complete.
 */
async function repairGrantResolution({ client, state, workItemId, projectDir, firstReason }) {
  let status;
  try {
    status = await client.status(state.relay_token);
  } catch (error) {
    return fail(TEAM_FAILURE_REASONS.SIGNED_GRANT_UNCONFIRMED, error?.code || error?.message || error);
  }
  if (status?.session_id !== state.remote_session_id) {
    return fail(TEAM_FAILURE_REASONS.SIGNED_GRANT_UNCONFIRMED, "session identity did not match");
  }
  // Remote is authoritative, but a repair must never adopt a policy that walks
  // backwards; that would make grants issued under an older revision match
  // again. Leave the failure unconfirmed instead.
  const regression = teamPolicyRegression(state, status);
  if (regression) return fail(TEAM_FAILURE_REASONS.SIGNED_GRANT_UNCONFIRMED, regression);

  updatePairingEnrollment(state.id, {
    scopeSet: status.scope_set || null,
    submissionApprovalEnabled: status.submission_approval_enabled,
    submissionPolicyRevision: status.submission_policy_revision,
    teamPublicationMode: status.team_publication_mode,
    teamPublicationRevision: status.team_publication_revision,
  });
  invalidateVerifiedTeamGrantCache();

  const refreshed = activeState(projectDir);
  if (!refreshed) return fail(TEAM_FAILURE_REASONS.SIGNED_GRANT_UNCONFIRMED, "session state is unavailable");
  let response;
  try {
    response = await client.teamGrants(refreshed.relay_token, refreshed.remote_session_id, workItemId);
  } catch (error) {
    return fail(TEAM_FAILURE_REASONS.SIGNED_GRANT_UNCONFIRMED, error?.code || error?.message || error);
  }
  const resolved = requireGrant(response, workItemId, refreshed);
  if (resolved.ok) return { ...resolved, state: refreshed, repaired: firstReason };
  // The refreshed view still does not verify. The stale-view explanation is
  // now ruled out, so report the confirmed failure rather than deferring.
  return { ...resolved, repairAttempted: true };
}

function verifiedGrantCacheKey(state, workItemId) {
  return JSON.stringify([
    state.remote_session_id, state.instance_id, state.remote_url, state.shared_branch,
    workItemId, state.scopeSet,
  ]);
}

/** Resolve a grant, repairing a stale local view once before giving up. */
async function resolveGrant({ client, state, workItemId, projectDir, response = null }) {
  const fetched = response
    ?? await client.teamGrants(state.relay_token, state.remote_session_id, workItemId);
  const resolved = requireGrant(fetched, workItemId, state);
  if (resolved.ok || !TEAM_GRANT_REPAIRABLE_REASONS.includes(resolved.reason)) {
    return { ...resolved, state };
  }
  return repairGrantResolution({ client, state, workItemId, projectDir, firstReason: resolved.reason });
}

export function invalidateVerifiedTeamGrantCache() {
  verifiedGrantCache.clear();
}

/** Tool-time grant lookup. A signed whole-WI group is cached for at most one
 * minute, bounded again by token expiry. Heartbeat policy/scope changes clear
 * the cache, while commit/submission always refetch current Remote state. */
export async function getVerifiedTeamGrantForWorkItem(localWorkItemId, {
  projectDir = process.cwd(),
  remoteClientFactory = createPairingRemoteClient,
  fresh = false,
} = {}) {
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || state.submission_approval_enabled !== 1) return fail("team_approval_not_active");
  const workItemId = teamWorkItemId(state, localWorkItemId);
  if (!workItemId) return fail("team_submission_identity_invalid");
  const cached = verifiedGrantCache.get(verifiedGrantCacheKey(state, workItemId));
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const client = remoteClientFactory();
    const resolved = await resolveGrant({ client, state, workItemId, projectDir });
    if (!resolved.ok) return resolved;
    // A repair re-reads session state, so key the entry by the state the grant
    // actually verified against rather than the stale view it started from.
    state = resolved.state || state;
    const cacheKey = verifiedGrantCacheKey(state, workItemId);
    const value = Object.freeze({
      ok: true,
      workItemContext: Object.freeze({
        workItemId,
        grantRevision: resolved.grant.revision,
        grantJti: resolved.claims.jti,
      }),
      effectivePermissions: resolved.grant.effective_permissions,
      memberScope: state.scopeSet,
      claimGeneration: resolved.grant.claim_generation,
      expiresAt: new Date(resolved.claims.exp * 1000).toISOString(),
      // Surfaced so a caller can record that a stale local view was repaired
      // rather than silently masking how often that happens.
      ...(resolved.repaired ? { repaired: resolved.repaired } : {}),
    });
    if (verifiedGrantCache.size >= MAX_TEAM_RECORDS) verifiedGrantCache.clear();
    verifiedGrantCache.set(cacheKey, {
      value,
      expiresAt: Math.min(resolved.claims.exp * 1000, Date.now() + MAX_VERIFIED_GRANT_CACHE_MS),
    });
    return value;
  } catch (error) {
    return fail("team_grant_unavailable", error?.code || error?.message || error);
  }
}

function submissionPins(submission) {
  return {
    submission_id: submission.id || submission.submission_id,
    work_item_id: submission.work_item_id,
    grant_revision: submission.grant_revision,
    grant_jti: submission.grant_jti,
    claim_generation: submission.claim_generation,
    source_oid: submission.source_oid,
    target_oid: submission.target_oid,
    candidate_oid: submission.candidate_oid,
    result_oid: submission.result_oid,
    policy_revision: submission.policy_revision,
  };
}

function exactSubmission(row, pins) {
  return row && Object.entries(pins).every(([key, value]) => String((key === "submission_id" ? row.id || row.submission_id : row[key]) ?? "") === String(value ?? ""));
}

function submittedRefPair(state, workItemId, sourceOid, candidateOid) {
  const digest = createHash("sha256")
    .update(`${state.remote_session_id}:${workItemId}:${sourceOid}:${candidateOid}`)
    .digest("hex").slice(0, 32);
  return {
    workbranch_ref: `refs/heads/posse/team/${digest}/source`,
    candidate_ref: `refs/heads/posse/team/${digest}/candidate`,
  };
}

function advertisedOid(projectDir, remote, ref) {
  const line = git(["ls-remote", remote, ref], projectDir).trim();
  const [oid, foundRef] = line.split(/\s+/u);
  return foundRef === ref && OID_RE.test(oid || "") ? oid : null;
}

function fetchExactRef(projectDir, remote, ref, oid) {
  if (!TEAM_REF_RE.test(ref) || ref.includes("..") || ref.endsWith(".lock") || !OID_RE.test(oid)) return false;
  git(["fetch", "--no-tags", remote, ref], projectDir);
  return git(["rev-parse", "--verify", "FETCH_HEAD"], projectDir) === oid;
}

function projectionRecords(payload, state) {
  if (payload?.contract_version !== 1 || payload.session_id !== state.remote_session_id
    || !Array.isArray(payload.submissions) || payload.submissions.length > MAX_TEAM_RECORDS) {
    return null;
  }
  return payload.submissions;
}

function githubReviewUrl(state, candidateRef) {
  const repository = githubRepositoryName(state.remote_url);
  if (!repository || !TEAM_REF_RE.test(String(candidateRef || ""))) return null;
  const candidateBranch = candidateRef.slice("refs/heads/".length);
  return `https://github.com/${repository}/compare/${encodeURIComponent(state.shared_branch)}...${encodeURIComponent(candidateBranch)}?expand=1`;
}

function validPermissions(permissions) {
  const write = permissions?.write;
  const tools = permissions?.tools ?? [];
  const database = permissions?.database ?? [];
  const budget = permissions?.budget;
  return permissions && typeof permissions === "object" && !Array.isArray(permissions)
    && write && write.unknown === false
    && Array.isArray(write.files) && Array.isArray(write.roots)
    && Array.isArray(tools) && Array.isArray(database)
    && write.files.length + write.roots.length + tools.length + database.length > 0
    && write.files.length <= TEAM_SCOPE_LIMITS.MAX_WRITE_ENTRIES
    && write.roots.length <= TEAM_SCOPE_LIMITS.MAX_WRITE_ENTRIES
    && [...write.files, ...write.roots].every((value) => cleanScopePath(value))
    && tools.length <= TEAM_SCOPE_LIMITS.MAX_TOOL_ENTRIES
    && database.length <= TEAM_SCOPE_LIMITS.MAX_DATABASE_ENTRIES
    && [...tools, ...database].every((value) => typeof value === "string"
      && value.length > 0 && value.length <= TEAM_SCOPE_LIMITS.MAX_LABEL_LENGTH
      && TEAM_SCOPE_LABEL_PATTERN.test(value))
    && (budget == null || (typeof budget === "object" && !Array.isArray(budget)
      && Number.isSafeInteger(budget.max_cost_micros) && budget.max_cost_micros > 0
      && Number.isSafeInteger(budget.max_tokens) && budget.max_tokens > 0));
}

function wholeSecondExpiry(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.floor(at / 1000) : null;
}

export async function requestTeamGrant({
  projectDir = process.cwd(),
  session_id: requestedSessionId,
  local_work_item_id: localWorkItemId,
  expected_revision: expectedRevision = 0,
  requested_permissions: requestedPermissions,
  expires_at: expiresAt,
  remoteClientFactory = createPairingRemoteClient,
} = {}) {
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || state.submission_approval_enabled !== 1) return fail("team_approval_not_active");
  if (requestedSessionId !== state.remote_session_id) return fail("team_session_changed");
  const workItemId = teamWorkItemId(state, localWorkItemId);
  const expiration = wholeSecondExpiry(expiresAt);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!workItemId || !validPermissions(requestedPermissions)
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || expiration == null || expiration <= nowSec || expiration - nowSec > 900) return fail("invalid_grant_request");
  try {
    const result = await remoteClientFactory().requestTeamGrant(state.relay_token, {
      session_id: state.remote_session_id,
      work_item_id: workItemId,
      expected_revision: expectedRevision,
      requested_permissions: requestedPermissions,
      expires_at: expiresAt,
    });
    const grant = result?.grant;
    if (result?.contract_version !== 1 || result.session_id !== state.remote_session_id
      || grant?.work_item_id !== workItemId || !Number.isSafeInteger(grant.requested_revision)) {
      return fail("invalid_grant_request_receipt");
    }
    invalidateVerifiedTeamGrantCache();
    return { ok: true, protocol: "posse.team_grant_request.v1", repo_path: path.resolve(projectDir),
      session_id: state.remote_session_id, work_item_id: workItemId,
      requested_revision: grant.requested_revision, state: grant.state };
  } catch (error) {
    return fail("team_grant_request_unavailable", error?.code || error?.message || error);
  }
}

export async function issueTeamGrant({
  projectDir = process.cwd(),
  session_id: requestedSessionId,
  work_item_id: workItemId,
  executor_instance_id: executorInstanceId,
  originator_instance_id: originatorInstanceId,
  expected_revision: expectedRevision,
  effective_permissions: effectivePermissions,
  state: grantState,
  file_handoff_confirmed: fileHandoffConfirmed = false,
  claim_generation: claimGeneration,
  expires_at: expiresAt,
  policy_revision: policyRevision,
  action_id: actionId = null,
  remoteClientFactory = createPairingRemoteClient,
} = {}) {
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || state.role !== "host" || state.submission_approval_enabled !== 1) return fail("team_host_required");
  if (requestedSessionId !== state.remote_session_id) return fail("team_session_changed");
  const expiration = wholeSecondExpiry(expiresAt);
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof workItemId !== "string" || !workItemId || workItemId.length > 128
    || typeof executorInstanceId !== "string" || !executorInstanceId
    || typeof originatorInstanceId !== "string" || !originatorInstanceId
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
    || !Number.isSafeInteger(policyRevision) || policyRevision !== Number(state.submission_approval_revision)
    || !Number.isSafeInteger(claimGeneration) || claimGeneration < 0
    || !["active", "waiting_for_files"].includes(grantState)
    || (grantState === "active" && fileHandoffConfirmed !== true)
    || !validPermissions(effectivePermissions)
    || expiration == null || expiration <= nowSec || expiration - nowSec > 900) {
    return fail("invalid_grant_issue");
  }
  try {
    const client = remoteClientFactory();
    const status = await client.status(state.relay_token);
    if (status.session_id !== state.remote_session_id || status.submission_approval_enabled !== true
      || status.submission_policy_revision !== policyRevision) return fail("team_policy_stale");
    const current = await client.teamGrants(state.relay_token, state.remote_session_id, workItemId);
    const requested = current?.contract_version === 1 && current.session_id === state.remote_session_id
      ? current.grants?.find((item) => item.work_item_id === workItemId) : null;
    const requestExpiresAt = Date.parse(requested?.requested_expires_at || "");
    if (!requested || requested.revision !== expectedRevision
      || requested.executor_instance_id !== executorInstanceId
      || provenOriginatorForGrant(state, requested) !== originatorInstanceId
      || !Number.isFinite(requestExpiresAt) || requestExpiresAt < expiration * 1000) {
      return fail("grant_request_stale");
    }
    if (!state.credential_directory) {
      state = updatePairingEnrollment(state.id, {
        credentialDirectory: path.join(projectDir, ".posse", "session-credentials", state.remote_session_id),
      });
    }
    const key = loadOrCreateTeamSigningKey(projectDir, state);
    const registered = await client.registerTeamSigningKey(state.relay_token, {
      session_id: state.remote_session_id,
      signing_public_key: key.signingPublicKey,
    });
    if (registered?.contract_version !== 1 || registered.session_id !== state.remote_session_id
      || registered.signing_public_key !== key.signingPublicKey || registered.kid !== key.kid) {
      return fail("team_signing_key_rejected");
    }
    const claims = {
      iss: `posse-session-host:${state.remote_session_id}`,
      sub: workItemId,
      aud: executorInstanceId,
      jti: newTeamGrantJti(),
      nbf: nowSec,
      exp: expiration,
      session_id: state.remote_session_id,
      repository_fingerprint: repositoryFingerprint(state.remote_url),
      branch: state.shared_branch,
      grant_revision: expectedRevision + 1,
      claim_generation: claimGeneration,
      policy_revision: policyRevision,
      effective_permissions: effectivePermissions,
    };
    const result = await client.issueTeamGrant(state.relay_token, {
      session_id: state.remote_session_id,
      work_item_id: workItemId,
      executor_instance_id: executorInstanceId,
      originator_instance_id: originatorInstanceId,
      expected_revision: expectedRevision,
      effective_permissions: effectivePermissions,
      state: grantState,
      claim_generation: claimGeneration,
      expires_at: expiresAt,
      decision_mode: "manual",
      policy_revision: policyRevision,
      signed_grant: signTeamGrantClaims(key.privateKey, key.kid, claims),
    });
    const grant = result?.grant;
    if (result?.contract_version !== 1 || result.session_id !== state.remote_session_id
      || grant?.work_item_id !== workItemId || grant.revision !== expectedRevision + 1
      || grant.claim_generation !== claimGeneration || grant.policy_revision !== policyRevision
      || grant.executor_instance_id !== executorInstanceId || grant.state !== grantState) {
      return fail("invalid_grant_issue_receipt");
    }
    const signed = verifyTeamGrantToken(grant, {
      sessionId: state.remote_session_id, instanceId: executorInstanceId,
      repositoryFingerprint: repositoryFingerprint(state.remote_url), branch: state.shared_branch,
      workItemId, signingPublicKey: grant.signing_public_key, kid: grant.kid,
    });
    if (!signed.ok) return signed;
    invalidateVerifiedTeamGrantCache();
    return { ok: true, protocol: "posse.team_grant_issue.v1", repo_path: path.resolve(projectDir),
      session_id: state.remote_session_id, work_item_id: workItemId,
      executor_instance_id: executorInstanceId, originator_instance_id: originatorInstanceId,
      expected_revision: expectedRevision, policy_revision: policyRevision,
      effective_permissions: effectivePermissions,
      grant_revision: grant.revision, state: grantState, claim_generation: claimGeneration,
      expires_at: expiresAt, ...(actionId ? { action_id: actionId } : {}) };
  } catch (error) {
    return fail("team_grant_issue_unavailable", error?.code || error?.message || error);
  }
}

/** The existing automatic side-trunk path remains the default. Opt-in mode
 * requires a live signed WI grant and an exact Remote approval receipt before
 * the coordinator may attempt its leased trunk push. */
export async function gateTeamCandidateForPublication({
  projectDir,
  operation,
  remoteClientFactory = createPairingRemoteClient,
} = {}) {
  const live = getLivePairingState();
  if (live?.submission_approval_enabled === 1 && live.phase !== "active") {
    return fail("team_session_unavailable");
  }
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state) return live?.submission_approval_enabled === 1
    ? fail("team_session_unavailable") : { ok: true, legacy: true };
  if (state.submission_approval_enabled !== 1) return { ok: true, legacy: true };
  const workItemId = teamWorkItemId(state, operation?.workItemId);
  if (!workItemId || !OID_RE.test(operation?.sourceSha || "")
    || !OID_RE.test(operation?.baseSha || "") || !OID_RE.test(operation?.candidateSha || "")) {
    return fail("team_submission_identity_invalid");
  }
  try {
    const client = remoteClientFactory();
    const status = await client.status(state.relay_token);
    if (status?.session_id !== state.remote_session_id
      || status.submission_approval_enabled !== true
      || status.submission_policy_revision !== Number(state.submission_approval_revision)
      || !["direct", "github-pr"].includes(status.team_publication_mode)
      || !Number.isSafeInteger(status.team_publication_revision)
      || status.team_publication_mode !== state.team_publication_mode
      || status.team_publication_revision !== Number(state.team_publication_revision)) {
      return fail("team_publication_policy_stale");
    }
    // The member may have only an SSH deploy key. The host's provider
    // actuator, which holds GitHub API credentials, verifies protection and
    // exact PR pins before publication. This gate still submits the immutable
    // Git refs and parks rather than attempting a direct trunk push.
    const resolved = await resolveGrant({ client, state, workItemId, projectDir });
    if (!resolved.ok) return resolved;
    state = resolved.state || state;
    const scope = verifyTeamGitScope({
      projectDir,
      targetOid: operation.baseSha,
      sourceOid: operation.sourceSha,
      candidateOid: operation.candidateSha,
      effectivePermissions: resolved.grant.effective_permissions,
      memberScope: state.scopeSet,
    });
    if (!scope.ok) return scope;
    const refs = submittedRefPair(state, workItemId, operation.sourceSha, operation.candidateSha);
    git(["push", "--atomic", state.remote_name,
      `${operation.sourceSha}:${refs.workbranch_ref}`,
      `${operation.candidateSha}:${refs.candidate_ref}`], projectDir);
    if (advertisedOid(projectDir, state.remote_name, refs.workbranch_ref) !== operation.sourceSha
      || advertisedOid(projectDir, state.remote_name, refs.candidate_ref) !== operation.candidateSha) {
      return fail("team_workbranch_unverifiable");
    }
    const pins = {
      session_id: state.remote_session_id,
      work_item_id: workItemId,
      grant_revision: resolved.grant.revision,
      grant_jti: resolved.claims.jti,
      claim_generation: resolved.grant.claim_generation,
      source_oid: operation.sourceSha,
      target_oid: operation.baseSha,
      candidate_oid: operation.candidateSha,
      result_oid: operation.candidateSha,
      policy_revision: resolved.grant.policy_revision,
      ...refs,
    };
    const submitted = await client.submitTeamWorkbranch(state.relay_token, pins);
    const row = submitted?.submission || submitted;
    const submissionId = row?.id || row?.submission_id;
    if (submitted?.session_id !== state.remote_session_id || !submissionId
      || !exactSubmission(row, { ...pins, submission_id: submissionId })) {
      return fail("invalid_submission_response");
    }
    const checkPins = { ...pins, submission_id: submissionId };
    delete checkPins.workbranch_ref;
    delete checkPins.candidate_ref;
    const checked = await client.checkTeamWorkbranch(state.relay_token, checkPins);
    const receiptComparison = { ...checkPins };
    delete receiptComparison.session_id;
    if (checked?.session_id !== state.remote_session_id || checked.approved !== true
      || !exactSubmission(checked.receipt, receiptComparison)
      || checked.receipt?.decision_actor_instance_id !== resolved.grant.originator_instance_id
      || typeof checked.receipt?.decision_action_id !== "string") {
      return fail("invalid_approval_receipt");
    }
    if (status.team_publication_mode === "github-pr") {
      return { ok: false, reason: "host_provider_merge_required", providerPending: true,
        submissionId, grantRevision: pins.grant_revision, candidateOid: pins.candidate_oid,
        candidateRef: refs.candidate_ref };
    }
    return { ok: true, submissionId, grantRevision: pins.grant_revision, candidateOid: pins.candidate_oid };
  } catch (error) {
    const code = String(error?.code || "");
    if (code === "pairing_submission_pending") return fail("approval_pending");
    if (code === "pairing_submission_denied") return fail("approval_denied");
    if (code === "pairing_submission_stale") return fail("approval_stale");
    return fail("approval_unavailable", error?.message || error);
  }
}

/** Recovery proof for a candidate that already appears on the temporary
 * trunk. A Git ancestry observation alone is insufficient for a Team WI:
 * the exact Remote decision and, in provider mode, the reviewed PR merge
 * must still agree with the journaled source/target/candidate OIDs. */
export async function verifyTeamPublishedCandidate({
  projectDir, operation, observedOid, remoteClientFactory = createPairingRemoteClient,
} = {}) {
  const live = getLivePairingState();
  const prior = getDb().prepare(`
    SELECT submission_approval_enabled FROM pairing_sessions
    WHERE shared_branch = ? AND remote_name = ? AND created_at <= ?
    ORDER BY created_at DESC LIMIT 1
  `).get(operation?.targetBranch, operation?.remote, operation?.createdAt || new Date().toISOString());
  if (!live || live.submission_approval_enabled !== 1) {
    return prior?.submission_approval_enabled === 1
      ? fail("team_session_unavailable") : { ok: true, legacy: true };
  }
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || !OID_RE.test(observedOid || "")) return fail("team_recovery_unavailable");
  const workItemId = teamWorkItemId(state, operation?.workItemId);
  if (!workItemId) return fail("team_submission_identity_invalid");
  try {
    const client = remoteClientFactory();
    const [status, listing, grantResponse] = await Promise.all([
      client.status(state.relay_token),
      client.teamSubmissions(state.relay_token, state.remote_session_id),
      client.teamGrants(state.relay_token, state.remote_session_id, workItemId),
    ]);
    if (status?.session_id !== state.remote_session_id || status.submission_approval_enabled !== true
      || status.submission_policy_revision !== Number(state.submission_approval_revision)
      || status.team_publication_mode !== state.team_publication_mode
      || status.team_publication_revision !== Number(state.team_publication_revision)
      || !projectionRecords(listing, state)
      || grantResponse?.contract_version !== 1 || grantResponse.session_id !== state.remote_session_id) {
      return fail("team_recovery_policy_stale");
    }
    const rows = listing.submissions.filter((row) => row.work_item_id === workItemId
      && row.source_oid === operation.sourceSha && row.target_oid === operation.baseSha
      && row.candidate_oid === operation.candidateSha && row.result_oid === operation.candidateSha
      && row.state === "approved");
    if (rows.length !== 1) return fail("team_approved_submission_missing");
    const row = rows[0];
    const grant = grantResponse.grants?.find((item) => item.work_item_id === workItemId);
    if (!grant || grant.executor_instance_id !== state.instance_id
      || grant.originator_instance_id !== row.decision_actor_instance_id
      || !row.decision_action_id || row.policy_revision !== Number(state.submission_approval_revision)
      || !["active", "merged"].includes(grant.state)
      || (grant.state === "active" && (grant.revision !== row.grant_revision
        || grant.grant_jti !== row.grant_jti
        || grant.current_submission_id !== (row.id || row.submission_id)
        || grant.claim_generation !== row.claim_generation
        || grant.policy_revision !== row.policy_revision))
      || (grant.state === "merged" && grant.revision !== row.grant_revision + 1)) {
      return fail("team_approval_receipt_stale");
    }
    if (!fetchExactRef(projectDir, state.remote_name, row.workbranch_ref, row.source_oid)
      || !fetchExactRef(projectDir, state.remote_name, row.candidate_ref, row.candidate_oid)) {
      return fail("submitted_refs_stale");
    }
    const scope = verifyTeamGitScope({ projectDir, targetOid: row.target_oid,
      sourceOid: row.source_oid, candidateOid: row.candidate_oid,
      effectivePermissions: grant.effective_permissions });
    if (!scope.ok) return scope;
    const trunkRef = `refs/heads/${state.shared_branch}`;
    if (advertisedOid(projectDir, state.remote_name, trunkRef) !== observedOid) return fail("team_trunk_moved");
    if (status.team_publication_mode === "direct") {
      return observedOid === row.candidate_oid ? { ok: true, acceptedOid: observedOid }
        : fail("team_candidate_not_current_trunk");
    }
    if (status.team_publication_mode === "github-pr") {
      const proof = await verifyPublishedTeamPullRequest({ projectDir, submission: row,
        remoteUrl: state.remote_url, targetBranch: state.shared_branch });
      return proof.ok && proof.branchOid === observedOid && proof.acceptedOid === observedOid
        ? { ok: true, acceptedOid: proof.acceptedOid, pullNumber: proof.pullNumber }
        : fail(proof.reason || "team_provider_merge_unverified");
    }
    return fail("team_publication_policy_stale");
  } catch (error) {
    return fail("team_recovery_unavailable", error?.code || error?.message || error);
  }
}

export async function setTeamSubmissionApproval(enabled, {
  projectDir = process.cwd(),
  remoteClientFactory = createPairingRemoteClient,
  action_id: actionId = null,
} = {}) {
  if (typeof enabled !== "boolean") return fail("invalid_team_policy");
  if (enabled && !MANAGED_FILE_WRITE_BOUNDARY_READY) return fail("team_managed_write_boundary_unavailable");
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || state.role !== "host") return fail("team_host_required");
  if (!enabled && getDb().prepare(`
    SELECT 1 AS pending FROM shared_trunk_merge_operations
    WHERE phase IN ('intent','candidate','publish_unknown') LIMIT 1
  `).get()) {
    return fail("unresolved_team_submission");
  }
  // Enable the local gate before asking Remote to enable the shared policy.
  // If the network result is unknown, this host must remain fail-closed.
  if (enabled) {
    getDb().prepare(`
      UPDATE pairing_sessions SET submission_approval_enabled = 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND phase = 'active' AND role = 'host'
    `).run(state.id);
  }
  try {
    const client = remoteClientFactory();
    const status = await client.status(state.relay_token);
    if (status.session_id !== state.remote_session_id
      || typeof status.submission_approval_enabled !== "boolean"
      || !Number.isSafeInteger(status.submission_policy_revision)) {
      return fail("team_relay_unsupported");
    }
    let revision = status.submission_policy_revision;
    if (status.submission_approval_enabled !== enabled) {
      const result = await client.setTeamSubmissionPolicy(state.relay_token, {
        session_id: state.remote_session_id,
        expected_revision: revision,
        enabled,
      });
      if (result?.contract_version !== 1 || result.session_id !== state.remote_session_id
        || result.submission_approval_enabled !== enabled
        || !Number.isSafeInteger(result.policy_revision) || result.policy_revision <= revision) {
        return fail("invalid_team_policy_receipt");
      }
      revision = result.policy_revision;
    }
    getDb().prepare(`
      UPDATE pairing_sessions SET submission_approval_enabled = ?, submission_approval_revision = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND phase = 'active' AND role = 'host'
    `).run(Number(enabled), revision, state.id);
    invalidateVerifiedTeamGrantCache();
    return { ok: true, protocol: "posse.team_policy.v1", repo_path: path.resolve(projectDir),
      session_id: state.remote_session_id, enabled, revision,
      ...(actionId ? { action_id: actionId } : {}) };
  } catch (error) {
    return fail("team_relay_unavailable", error?.code || error?.message || error);
  }
}

export async function setTeamPublicationMode(mode, {
  projectDir = process.cwd(), remoteClientFactory = createPairingRemoteClient,
} = {}) {
  if (!["direct", "github-pr"].includes(mode)) return fail("invalid_team_publication_mode");
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || state.role !== "host") return fail("team_host_required");
  try {
    const client = remoteClientFactory();
    const status = await client.status(state.relay_token);
    if (status?.session_id !== state.remote_session_id || status?.role !== "host"
      || !["direct", "github-pr"].includes(status.team_publication_mode)
      || !Number.isSafeInteger(status.team_publication_revision)
      || !Number.isSafeInteger(status.active_members) || status.active_members !== 0) {
      return fail("team_publication_policy_unavailable");
    }
    if (mode === "github-pr") {
      if (status.submission_approval_enabled !== true) return fail("team_approval_required");
      const protection = await verifyProtectedTeamBranch({
        projectDir, remoteUrl: state.remote_url, targetBranch: state.shared_branch,
      });
      if (!protection.ok) return fail(protection.reason);
      const remoteOid = advertisedOid(projectDir, state.remote_name, `refs/heads/${state.shared_branch}`);
      if (!remoteOid || remoteOid !== protection.protection.observedOid) return fail("github_target_moved");
    }
    let revision = status.team_publication_revision;
    if (status.team_publication_mode !== mode) {
      const changed = await client.setTeamPublicationMode(state.relay_token, {
        session_id: state.remote_session_id, expected_revision: revision, mode,
      });
      if (changed?.contract_version !== 1 || changed.session_id !== state.remote_session_id
        || changed.team_publication_mode !== mode
        || !Number.isSafeInteger(changed.team_publication_revision)
        || changed.team_publication_revision !== revision + 1) {
        return fail("invalid_team_publication_receipt");
      }
      revision = changed.team_publication_revision;
    }
    updatePairingEnrollment(state.id, {
      teamPublicationMode: mode, teamPublicationRevision: revision,
    });
    return { ok: true, protocol: "posse.team_publication_mode.v1",
      repo_path: path.resolve(projectDir), session_id: state.remote_session_id,
      mode, revision };
  } catch (error) {
    return fail("team_publication_mode_unavailable", error?.code || error?.message || error);
  }
}

function exactWriteFile(permissions) {
  const write = permissions?.write;
  return write?.unknown === false && Array.isArray(write.files) && write.files.length === 1
    && Array.isArray(write.roots) && write.roots.length === 0
    ? write.files[0] : null;
}

function writeCoversFile(permissions, file) {
  const write = permissions?.write;
  if (!write || write.unknown !== false
    || !Array.isArray(write.files) || !Array.isArray(write.roots)) return true;
  return write.files.includes(file) || write.roots.some((root) =>
    file === root || file.startsWith(`${root.replace(/\/$/u, "")}/`));
}

function handoffMatch(grants, submissions, state) {
  if (!Array.isArray(grants) || !Array.isArray(submissions)
    || grants.length > MAX_TEAM_RECORDS || submissions.length > MAX_TEAM_RECORDS) return null;
  for (const submission of submissions) {
    if (submission?.state !== "approved" || !OID_RE.test(submission.candidate_oid || "")) continue;
    const predecessor = grants.find((grant) => grant.work_item_id === submission.work_item_id);
    const file = exactWriteFile(predecessor?.effective_permissions);
    if (!file || predecessor.state !== "active" || predecessor.revision !== submission.grant_revision
      || predecessor.grant_jti !== submission.grant_jti
      || predecessor.claim_generation !== submission.claim_generation
      || predecessor.originator_instance_id !== submission.decision_actor_instance_id
      || predecessor.current_submission_id !== (submission.id || submission.submission_id)
      || predecessor.policy_revision !== Number(state.submission_approval_revision)) continue;
    const waiting = grants.filter((grant) => grant.state === "waiting_for_files"
      && grant.work_item_id !== predecessor.work_item_id
      && writeCoversFile(grant.effective_permissions, file));
    if (waiting.length !== 1 || exactWriteFile(waiting[0].effective_permissions) !== file) continue;
    const occupiers = grants.filter((grant) => grant.state === "active"
      && writeCoversFile(grant.effective_permissions, file));
    if (occupiers.length !== 1 || occupiers[0].work_item_id !== predecessor.work_item_id) continue;
    const successor = waiting[0];
    if (!provenOriginatorForGrant(state, successor)
      || provenOriginatorForGrant(state, successor) !== successor.originator_instance_id
      || !validPermissions(successor.effective_permissions)
      || !Number.isSafeInteger(successor.revision) || successor.revision < 1) continue;
    return { submission, predecessor, successor, file };
  }
  return null;
}

/** Host-only one-file handoff. The host reads accepted Git objects from the
 * temporary remote and atomically closes A's grant while issuing B's signed
 * active grant. Pending approval or an unverified push never releases a file. */
export async function reconcileTeamFileHandoff({
  projectDir = process.cwd(), remoteClientFactory = createPairingRemoteClient,
} = {}) {
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || state.role !== "host" || state.submission_approval_enabled !== 1) return fail("team_host_required");
  try {
    const client = remoteClientFactory();
    const [status, grantResponse, submissionResponse] = await Promise.all([
      client.status(state.relay_token),
      client.teamGrants(state.relay_token, state.remote_session_id),
      client.teamSubmissions(state.relay_token, state.remote_session_id),
    ]);
    if (status?.session_id !== state.remote_session_id || status.submission_approval_enabled !== true
      || status.submission_policy_revision !== Number(state.submission_approval_revision)
      || !["direct", "github-pr"].includes(status.team_publication_mode)
      || !Number.isSafeInteger(status.team_publication_revision)
      || grantResponse?.contract_version !== 1 || grantResponse.session_id !== state.remote_session_id
      || submissionResponse?.contract_version !== 1 || submissionResponse.session_id !== state.remote_session_id) {
      return fail("team_handoff_policy_stale");
    }
    const match = handoffMatch(grantResponse.grants, submissionResponse.submissions, state);
    if (!match) return { ok: true, skipped: "no_unambiguous_one_file_handoff" };
    const { submission, predecessor, successor } = match;
    const trunkRef = `refs/heads/${state.shared_branch}`;
    const observedTrunkOid = advertisedOid(projectDir, state.remote_name, trunkRef);
    if (!observedTrunkOid) return fail("team_trunk_unverifiable");
    if (status.team_publication_mode === "direct" && observedTrunkOid !== submission.candidate_oid) {
      return fail("team_candidate_not_current_trunk");
    }
    let acceptedOid = observedTrunkOid;
    if (status.team_publication_mode === "github-pr") {
      const proof = await verifyPublishedTeamPullRequest({
        projectDir, submission, remoteUrl: state.remote_url,
        targetBranch: state.shared_branch,
      });
      if (!proof.ok) return fail(proof.reason || "team_provider_handoff_receipt_required");
      if (proof.branchOid !== observedTrunkOid || proof.acceptedOid !== observedTrunkOid) {
        return fail("team_provider_trunk_moved");
      }
      acceptedOid = proof.acceptedOid;
    }
    git(["fetch", "--no-tags", state.remote_name, trunkRef], projectDir);
    if (git(["rev-parse", "--verify", "FETCH_HEAD"], projectDir) !== observedTrunkOid) return fail("team_trunk_moved");
    if (!fetchExactRef(projectDir, state.remote_name, submission.candidate_ref, submission.candidate_oid)) {
      return fail("team_candidate_unverifiable");
    }
    try {
      git(["merge-base", "--is-ancestor", submission.candidate_oid, acceptedOid], projectDir);
      git(["merge-base", "--is-ancestor", acceptedOid, observedTrunkOid], projectDir);
    } catch {
      return fail("team_candidate_not_accepted");
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const requestedAt = Date.parse(successor.requested_expires_at || "");
    const requestExpiry = Number.isFinite(requestedAt) ? Math.floor(requestedAt / 1000) : 0;
    const expiration = Math.min(requestExpiry, nowSec + 600);
    const claimGeneration = Math.max(predecessor.claim_generation, successor.claim_generation) + 1;
    if (expiration <= nowSec || !Number.isSafeInteger(claimGeneration)
      || successor.policy_revision !== Number(state.submission_approval_revision)) return fail("team_successor_stale");
    if (!state.credential_directory) {
      state = updatePairingEnrollment(state.id, {
        credentialDirectory: path.join(projectDir, ".posse", "session-credentials", state.remote_session_id),
      });
    }
    const key = loadOrCreateTeamSigningKey(projectDir, state);
    const registered = await client.registerTeamSigningKey(state.relay_token, {
      session_id: state.remote_session_id, signing_public_key: key.signingPublicKey,
    });
    if (registered?.contract_version !== 1 || registered.session_id !== state.remote_session_id
      || registered.kid !== key.kid || registered.signing_public_key !== key.signingPublicKey) {
      return fail("team_signing_key_rejected");
    }
    const expiresAt = new Date(expiration * 1000).toISOString().replace(".000Z", "Z");
    const successorGrantJti = newTeamGrantJti();
    const signedGrant = signTeamGrantClaims(key.privateKey, key.kid, {
      iss: `posse-session-host:${state.remote_session_id}`,
      sub: successor.work_item_id, aud: successor.executor_instance_id,
      jti: successorGrantJti, nbf: nowSec, exp: expiration,
      session_id: state.remote_session_id,
      repository_fingerprint: repositoryFingerprint(state.remote_url),
      branch: state.shared_branch,
      grant_revision: successor.revision + 1,
      claim_generation: claimGeneration,
      policy_revision: successor.policy_revision,
      effective_permissions: successor.effective_permissions,
    });
    if (advertisedOid(projectDir, state.remote_name, trunkRef) !== observedTrunkOid) {
      return fail("team_trunk_moved_before_handoff");
    }
    const actionId = randomUUID();
    const result = await client.handoffTeamGrant(state.relay_token, {
      session_id: state.remote_session_id,
      predecessor_work_item_id: predecessor.work_item_id,
      predecessor_submission_id: submission.id || submission.submission_id,
      predecessor_expected_revision: predecessor.revision,
      predecessor_grant_jti: predecessor.grant_jti,
      accepted_oid: acceptedOid,
      successor: {
        work_item_id: successor.work_item_id,
        executor_instance_id: successor.executor_instance_id,
        originator_instance_id: successor.originator_instance_id,
        expected_revision: successor.revision,
        effective_permissions: successor.effective_permissions,
        state: "active", claim_generation: claimGeneration,
        expires_at: expiresAt, decision_mode: "manual",
        policy_revision: successor.policy_revision,
        signed_grant: signedGrant,
      },
      action_id: actionId,
    });
    const receipt = result?.receipt;
    if (result?.contract_version !== 1 || result.session_id !== state.remote_session_id
      || receipt?.action_id !== actionId || receipt.session_id !== state.remote_session_id
      || receipt.predecessor_work_item_id !== predecessor.work_item_id
      || receipt.predecessor_submission_id !== (submission.id || submission.submission_id)
      || receipt.predecessor_grant_revision !== predecessor.revision
      || receipt.predecessor_grant_jti !== predecessor.grant_jti
      || receipt.successor_work_item_id !== successor.work_item_id
      || receipt.successor_grant_revision !== successor.revision + 1
      || receipt.successor_grant_jti !== successorGrantJti
      || receipt.claim_generation !== claimGeneration || receipt.accepted_oid !== acceptedOid) {
      return fail("team_handoff_receipt_invalid");
    }
    invalidateVerifiedTeamGrantCache();
    return { ok: true, handedOff: true, acceptedOid,
      predecessorWorkItemId: predecessor.work_item_id,
      successorWorkItemId: successor.work_item_id, claimGeneration };
  } catch (error) {
    return fail("team_handoff_unavailable", error?.code || error?.message || error);
  }
}

export async function projectTeamOverview({
  projectDir = process.cwd(),
  remoteClientFactory = createPairingRemoteClient,
} = {}) {
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state) return fail("team_not_paired");
  const promotionJournal = state.role === "host" ? readPairingPromotionJournal() : null;
  const promotion = promotionJournal?.session_id === state.remote_session_id
    && promotionJournal.approval_required === true
    && promotionJournal.phase === "candidate"
    && ["squash", "fast-forward"].includes(promotionJournal.strategy)
    && OID_RE.test(promotionJournal.candidate_sha || "")
    && OID_RE.test(promotionJournal.target_base_sha || "")
    ? { strategy: promotionJournal.strategy, phase: "candidate",
      source_oid: promotionJournal.candidate_sha,
      origin_oid: promotionJournal.target_base_sha,
      target_branch: promotionJournal.target_branch }
    : null;
  const promotionOnly = () => promotion ? {
    ok: true, protocol: "posse.team_overview.v1", repo_path: path.resolve(projectDir),
    session_id: state.remote_session_id, instance_id: state.instance_id,
    trunk_oid: null, observed_at: new Date().toISOString(), revision: 0,
    approval_policy: state.submission_approval_enabled === 1 ? "originator_gate" : "legacy_auto",
    promotion, members: [], submissions: [], capabilities: ["team.promotion.approve"],
  } : fail("team_overview_unavailable");
  try {
    const client = remoteClientFactory();
    const [grantResponse, submissionResponse] = await Promise.all([
      client.teamGrants(state.relay_token, state.remote_session_id),
      client.teamSubmissions(state.relay_token, state.remote_session_id),
    ]);
    if (grantResponse?.contract_version !== 1 || grantResponse.session_id !== state.remote_session_id
      || !Array.isArray(grantResponse.grants) || grantResponse.grants.length > MAX_TEAM_RECORDS) {
      return fail("invalid_grant_response");
    }
    const submissions = projectionRecords(submissionResponse, state);
    if (!submissions) return fail("invalid_submission_response");
    let publicationStatus = null;
    let publicationCurrent = false;
    if (state.role === "host") {
      try {
        publicationStatus = await client.status(state.relay_token);
        publicationCurrent = publicationStatus?.session_id === state.remote_session_id
          && publicationStatus.team_publication_mode === state.team_publication_mode
          && publicationStatus.team_publication_revision === Number(state.team_publication_revision)
          && Number.isSafeInteger(publicationStatus.active_members);
      } catch { /* provider controls stay hidden when Remote cannot be checked */ }
    }
    const providerReady = publicationCurrent && state.team_publication_mode === "github-pr"
      && publicationStatus.submission_approval_enabled === true
      && publicationStatus.submission_policy_revision === Number(state.submission_approval_revision);
    const approvalPolicyCurrent = publicationCurrent
      && publicationStatus.submission_approval_enabled === (state.submission_approval_enabled === 1)
      && publicationStatus.submission_policy_revision === Number(state.submission_approval_revision);
    const snapshot = readPairingPeerSnapshot();
    const peers = snapshot?.session_id === state.remote_session_id ? snapshot.peers || [] : [];
    const members = grantResponse.grants.map((grant) => {
      const peer = peers.find((item) => item.instance_id === grant.executor_instance_id);
      const originatorId = provenOriginatorForGrant(state, grant);
      const work = peer?.work_items?.find((item) => `${originatorId}:${item.id}` === grant.work_item_id);
      return {
        member_id: grant.executor_instance_id,
        name: peer?.label || grant.executor_instance_id,
        work_item_id: grant.work_item_id,
        work_state: work?.status || grant.state || "unknown",
        agent_state: peer?.jobs?.[0]?.status || "unknown",
        requested_paths: [...(grant.requested_permissions?.write?.files || []), ...(grant.requested_permissions?.write?.roots || [])],
        grant_paths: [...(grant.effective_permissions?.write?.files || []), ...(grant.effective_permissions?.write?.roots || [])],
        claim_paths: null,
        waiting_paths: grant.state === "waiting_for_files" ? [...(grant.effective_permissions?.write?.files || [])] : [],
        claim_generation: grant.claim_generation || 0,
        payer_id: grant.payer_instance_id || grant.executor_instance_id,
        executor_id: grant.executor_instance_id,
        stale: !peer,
        permission_request: grant.requested_permissions || null,
        requested_permissions: grant.requested_permissions || null,
        requested_revision: grant.requested_revision || 0,
        issue_expected_revision: grant.revision || 0,
        request_expected_revision: grant.revision || 0,
        effective_grant: grant.effective_permissions || null,
        permission_state: grant.state || "unknown",
        expires_at: grant.expires_at || null,
        originator_instance_id: originatorId,
        policy_revision: grant.policy_revision || Number(state.submission_approval_revision) || 0,
        // Remote's grant state is authoritative for availability. The list
        // response does not include the atomic handoff receipt, so do not
        // attribute an active grant to an accepted merge here.
        recommended_issue_state: "waiting_for_files",
        file_availability_state: grant.state === "waiting_for_files" ? "waiting_for_handoff"
          : grant.state === "active" ? "active_grant" : grant.state || "unavailable",
        capabilities: state.role === "host" && state.submission_approval_enabled === 1
          && originatorId
          && Number.isSafeInteger(grant.requested_revision)
          && grant.requested_revision > 0 ? ["team.grant.issue"] : [],
      };
    });
    for (const peer of peers) {
      if (members.length >= MAX_TEAM_RECORDS) break;
      if (members.some((member) => member.member_id === peer.instance_id)) continue;
      members.push({
        member_id: peer.instance_id,
        name: peer.label || peer.instance_id,
        work_item_id: null,
        work_state: peer.work_items?.[0]?.status || "unassigned",
        agent_state: peer.jobs?.[0]?.status || "unknown",
        requested_paths: [], grant_paths: [], claim_paths: null, waiting_paths: [],
        claim_generation: 0, payer_id: null, executor_id: peer.instance_id,
        stale: false, permission_request: null, requested_permissions: null,
        requested_revision: 0, issue_expected_revision: 0, request_expected_revision: 0,
        effective_grant: null, permission_state: "unrequested", expires_at: null,
        originator_instance_id: null, policy_revision: Number(state.submission_approval_revision) || 0,
        recommended_issue_state: null, file_availability_state: "unavailable", capabilities: [],
      });
    }
    const trunkOid = advertisedOid(projectDir, state.remote_name, `refs/heads/${state.shared_branch}`);
    const projectedSubmissions = submissions.map((row) => {
      const grant = grantResponse.grants.find((item) => item.work_item_id === row.work_item_id);
      const providerEligible = providerReady && grant?.state === "active"
        && grant.revision === row.grant_revision && grant.policy_revision === row.policy_revision
        && trunkOid === row.target_oid && ["pending", "approved"].includes(row.state);
      return {
        submission_id: row.id || row.submission_id,
        work_item_id: row.work_item_id,
        target_oid: row.target_oid,
        candidate_oid: row.candidate_oid,
        grant_revision: row.grant_revision,
        policy_revision: row.policy_revision,
        check_state: row.check_state || "unverified",
        scope_state: row.scope_state || "unverified",
        state: row.state,
        capabilities: [
          ...(grant?.originator_instance_id === state.instance_id && row.state === "pending"
            ? ["team.submission.decide"] : []),
          ...(providerEligible ? ["team.provider_pr.prepare"] : []),
          ...(providerEligible && row.state === "approved" ? ["team.provider_pr.publish"] : []),
        ],
        source_oid: row.source_oid,
        result_oid: row.result_oid,
        workbranch_ref: row.workbranch_ref,
        candidate_ref: row.candidate_ref,
        review_url: githubReviewUrl(state, row.candidate_ref),
        pr_url: null,
        originator_instance_id: grant?.originator_instance_id || null,
        executor_instance_id: grant?.executor_instance_id || null,
      };
    });
    if (providerReady) {
      const lookups = projectedSubmissions
        .filter((row) => ["pending", "approved"].includes(row.state) && row.candidate_ref)
        .slice(0, 8);
      const found = await Promise.allSettled(lookups.map((row) => findTeamPullRequest({
        projectDir, remoteUrl: state.remote_url, targetBranch: state.shared_branch,
        candidateRef: row.candidate_ref, candidateOid: row.candidate_oid,
      })));
      found.forEach((outcome, index) => {
        const value = outcome.status === "fulfilled" ? outcome.value : null;
        const repoName = githubRepositoryName(state.remote_url);
        if (value?.ok && value.found && Number.isSafeInteger(value.pullNumber)
          && value.url === `https://github.com/${repoName}/pull/${value.pullNumber}`) {
          lookups[index].pr_url = value.url;
        }
      });
    }
    return {
      ok: true,
      protocol: "posse.team_overview.v1",
      repo_path: path.resolve(projectDir),
      session_id: state.remote_session_id,
      instance_id: state.instance_id,
      trunk_oid: trunkOid,
      observed_at: new Date().toISOString(),
      revision: Math.max(0, Number(submissionResponse.revision) || 0, Number(grantResponse.revision) || 0),
      approval_policy: state.submission_approval_enabled === 1 ? "originator_gate" : "legacy_auto",
      promotion,
      members,
      submissions: projectedSubmissions,
      capabilities: [
        ...(approvalPolicyCurrent && (state.submission_approval_enabled === 1
          || (publicationStatus.active_members === 0 && MANAGED_FILE_WRITE_BOUNDARY_READY))
          ? ["team.policy.set"] : []),
        ...(publicationCurrent && publicationStatus.active_members === 0 && trunkOid
          ? ["team.provider_protection.configure"] : []),
        ...(promotion ? ["team.promotion.approve"] : []),
        "team.submission.decide",
        ...(state.submission_approval_enabled === 1 ? ["team.grant.request"] : []),
      ],
    };
  } catch (error) {
    return promotion ? promotionOnly() : fail("team_overview_unavailable", error?.message || error);
  }
}

export async function decideTeamSubmission(args = {}) {
  const projectDir = args.projectDir || process.cwd();
  let state;
  try { state = activeState(projectDir); } catch { state = null; }
  if (!state || state.submission_approval_enabled !== 1) return fail("team_approval_not_active");
  if (args.session_id !== state.remote_session_id || !["approve", "deny"].includes(args.decision)
    || !OID_RE.test(args.target_oid || "") || !OID_RE.test(args.candidate_oid || "")) {
    return fail("invalid_team_decision");
  }
  try {
    const client = (args.remoteClientFactory || createPairingRemoteClient)();
    const list = await client.teamSubmissions(state.relay_token, state.remote_session_id);
    const submissions = projectionRecords(list, state);
    if (!submissions) return fail("invalid_submission_response");
    const row = submissions.find((item) => (item.id || item.submission_id) === args.submission_id);
    const desiredState = args.decision === "approve" ? "approved" : "denied";
    const alreadyDecidedByThisAction = row?.state === desiredState
      && row.decision_action_id === args.action_id
      && row.decision_actor_instance_id === state.instance_id;
    if (!row || row.work_item_id !== args.work_item_id || row.target_oid !== args.target_oid
      || row.candidate_oid !== args.candidate_oid || row.grant_revision !== args.grant_revision
      || row.policy_revision !== args.policy_revision
      || (row.state !== "pending" && !alreadyDecidedByThisAction)) {
      return fail("submission_stale");
    }
    if (!alreadyDecidedByThisAction) {
      const grantResponse = await client.teamGrants(state.relay_token, state.remote_session_id, row.work_item_id);
      const grant = grantResponse?.contract_version === 1 && grantResponse.session_id === state.remote_session_id
        ? grantResponse.grants?.find((item) => item.work_item_id === row.work_item_id) : null;
      if (!grant || grant.originator_instance_id !== state.instance_id) return fail("originator_required");
      if (args.decision === "approve") {
        if (grant.revision !== row.grant_revision || grant.claim_generation !== row.claim_generation
          || grant.policy_revision !== row.policy_revision || grant.state !== "active") return fail("grant_stale");
        const signed = verifyTeamGrantToken(grant, {
          sessionId: state.remote_session_id,
          instanceId: grant.executor_instance_id,
          repositoryFingerprint: repositoryFingerprint(state.remote_url),
          branch: state.shared_branch,
          workItemId: row.work_item_id,
          signingPublicKey: grantResponse.signing_public_key || grant.signing_public_key,
          kid: grantResponse.kid || grant.kid,
        });
        if (!signed.ok || signed.claims.jti !== row.grant_jti) return fail("grant_stale");
        const trunkRef = `refs/heads/${state.shared_branch}`;
        if (advertisedOid(projectDir, state.remote_name, trunkRef) !== row.target_oid) return fail("target_moved");
        git(["fetch", "--no-tags", state.remote_name, trunkRef], projectDir);
        if (git(["rev-parse", "--verify", "FETCH_HEAD"], projectDir) !== row.target_oid) {
          return fail("target_moved");
        }
        if (!fetchExactRef(projectDir, state.remote_name, row.workbranch_ref, row.source_oid)
          || !fetchExactRef(projectDir, state.remote_name, row.candidate_ref, row.candidate_oid)) {
          return fail("submitted_refs_stale");
        }
        const scope = verifyTeamGitScope({
          projectDir, targetOid: row.target_oid, sourceOid: row.source_oid,
          candidateOid: row.candidate_oid, effectivePermissions: grant.effective_permissions,
        });
        if (!scope.ok) return scope;
      }
    }
    const pins = submissionPins(row);
    const result = await client.decideTeamWorkbranch(state.relay_token, {
      ...pins, session_id: state.remote_session_id,
      decision: args.decision, action_id: args.action_id,
    });
    const receipt = result?.submission || result;
    if (result?.session_id !== state.remote_session_id || !exactSubmission(receipt, pins)
      || receipt?.state !== desiredState) {
      return fail("invalid_team_decision_receipt");
    }
    return {
      ok: true,
      protocol: "posse.team_decision.v1",
      repo_path: path.resolve(projectDir),
      action_id: args.action_id,
      session_id: state.remote_session_id,
      work_item_id: row.work_item_id,
      submission_id: pins.submission_id,
      grant_revision: row.grant_revision,
      target_oid: row.target_oid,
      candidate_oid: row.candidate_oid,
      policy_revision: row.policy_revision,
      decision: args.decision,
      state: receipt.state,
      result_oid: row.result_oid,
    };
  } catch (error) {
    return fail("team_decision_unavailable", error?.code || error?.message || error);
  }
}
