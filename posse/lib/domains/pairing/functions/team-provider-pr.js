import path from "node:path";

import { adminGitExec } from "../../git/functions/admin-git.js";
import { repositoryFingerprint } from "./git.js";
import {
  configureProtectedTeamBranch,
  createOrVerifyTeamPullRequest,
  findTeamPullRequest,
  inspectTeamPullRequestMerge,
  mergeApprovedTeamPullRequest,
} from "./github-team-pr.js";
import { createPairingRemoteClient } from "./remote-client.js";
import { getLivePairingState } from "./state.js";
import { verifyTeamGrantToken } from "./team-grant-token.js";
import { verifyTeamGitScope } from "./team-scope.js";

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const TEAM_REF_RE = /^refs\/heads\/posse\/team\/[A-Za-z0-9._/-]{1,160}\/(?:source|candidate)$/u;
const MAX_ROWS = 100;

function fail(reason) { return { ok: false, reason }; }

function git(projectDir, args) {
  return adminGitExec(args, projectDir, { timeoutMs: 60_000 });
}

function observedRef(projectDir, remote, ref) {
  if (!TEAM_REF_RE.test(ref || "") || ref.includes("..")) return null;
  const line = git(projectDir, ["ls-remote", remote, ref]).trim();
  const [oid, foundRef] = line.split(/\s+/u);
  return foundRef === ref && OID_RE.test(oid || "") ? oid : null;
}

function fetchExact(projectDir, remote, ref, oid) {
  if (observedRef(projectDir, remote, ref) !== oid) return false;
  git(projectDir, ["fetch", "--no-tags", remote, ref]);
  return git(projectDir, ["rev-parse", "--verify", "FETCH_HEAD"]).trim() === oid;
}

/** Host-only setup for the protected publication mode. The required CI
 * context and App ID are operator-selected; Posse never guesses them. */
export async function configureHostTeamBranchProtection({
  projectDir = process.cwd(),
  session_id: sessionId,
  target_oid: targetOid,
  required_check_context: requiredCheckContext,
  required_check_app_id: requiredCheckAppId,
  action_id: actionId = null,
  remoteClientFactory = createPairingRemoteClient,
  providerOptions = {},
} = {}) {
  let state;
  try {
    state = getLivePairingState();
    if (path.resolve(projectDir) !== path.resolve(git(projectDir, ["rev-parse", "--show-toplevel"]))) {
      state = null;
    }
  } catch { state = null; }
  if (!state || state.phase !== "active" || state.role !== "host"
    || state.remote_session_id !== sessionId || !state.relay_token
    || !OID_RE.test(targetOid || "")) return fail("team_provider_host_required");
  try {
    const client = remoteClientFactory();
    const status = await client.status(state.relay_token);
    if (status?.session_id !== sessionId
      || !["direct", "github-pr"].includes(status.team_publication_mode)
      || status.team_publication_mode !== state.team_publication_mode
      || status.team_publication_revision !== state.team_publication_revision
      || !Number.isSafeInteger(status.active_members) || status.active_members !== 0) {
      return fail("team_provider_policy_stale");
    }
    const ref = `refs/heads/${state.shared_branch}`;
    const line = git(projectDir, ["ls-remote", state.remote_name, ref]).trim();
    const [oid, name] = line.split(/\s+/u);
    if (name !== ref || oid !== targetOid) return fail("github_target_moved");
    const configured = await configureProtectedTeamBranch({
      projectDir, remoteUrl: state.remote_url, targetBranch: state.shared_branch,
      expectedTargetOid: targetOid, requiredCheckContext, requiredCheckAppId,
    }, providerOptions);
    if (!configured.ok) return configured;
    return {
      ok: true, protocol: "posse.team_provider_protection.v1",
      repo_path: path.resolve(projectDir), session_id: sessionId,
      target_oid: targetOid, publication_revision: state.team_publication_revision,
      required_check_context: requiredCheckContext,
      required_check_app_id: requiredCheckAppId,
      protection: configured.protection,
      ...(typeof actionId === "string" && actionId.length > 0 ? { action_id: actionId } : {}),
    };
  } catch {
    return fail("team_provider_protection_unavailable");
  }
}

/** The host owns the GitHub API credential. A member's Session deploy key can
 * publish exact review refs, but cannot open a PR. This host actuator reads
 * current Remote pins, Git refs, grant and provider policy before creating it. */
export async function prepareTeamSubmissionPullRequest({
  projectDir = process.cwd(),
  session_id: sessionId,
  submission_id: submissionId,
  work_item_id: workItemId,
  target_oid: targetOid,
  candidate_oid: candidateOid,
  grant_revision: grantRevision,
  policy_revision: policyRevision,
  action_id: actionId = null,
  remoteClientFactory = createPairingRemoteClient,
  providerOptions = {},
} = {}) {
  let state;
  try {
    state = getLivePairingState();
    if (path.resolve(projectDir) !== path.resolve(git(projectDir, ["rev-parse", "--show-toplevel"]))) {
      state = null;
    }
  } catch { state = null; }
  if (!state || state.phase !== "active" || state.role !== "host"
    || state.submission_approval_enabled !== 1 || state.team_publication_mode !== "github-pr"
    || !Number.isSafeInteger(state.team_publication_revision)
    || state.team_publication_revision <= 0) {
    return fail("team_provider_host_required");
  }
  if (sessionId !== state.remote_session_id || !submissionId || !workItemId
    || !OID_RE.test(targetOid || "") || !OID_RE.test(candidateOid || "")
    || !Number.isSafeInteger(grantRevision) || grantRevision <= 0
    || !Number.isSafeInteger(policyRevision) || policyRevision < 0) {
    return fail("team_provider_pins_invalid");
  }
  try {
    const client = remoteClientFactory();
    const status = await client.status(state.relay_token);
    if (status?.session_id !== sessionId || status.team_publication_mode !== "github-pr"
      || status.team_publication_revision !== state.team_publication_revision
      || status.submission_approval_enabled !== true
      || status.submission_policy_revision !== policyRevision) return fail("team_provider_policy_stale");
    const listed = await client.teamSubmissions(state.relay_token, sessionId);
    if (listed?.contract_version !== 1 || listed.session_id !== sessionId
      || !Array.isArray(listed.submissions) || listed.submissions.length > MAX_ROWS) {
      return fail("team_provider_submission_invalid");
    }
    const row = listed.submissions.find((item) => (item?.id || item?.submission_id) === submissionId);
    if (!row || !["pending", "approved"].includes(row.state)
      || row.work_item_id !== workItemId || row.target_oid !== targetOid
      || row.candidate_oid !== candidateOid || row.result_oid !== candidateOid
      || row.grant_revision !== grantRevision || row.policy_revision !== policyRevision
      || !TEAM_REF_RE.test(row.workbranch_ref || "") || !row.workbranch_ref.endsWith("/source")
      || !TEAM_REF_RE.test(row.candidate_ref || "") || !row.candidate_ref.endsWith("/candidate")) {
      return fail("team_provider_submission_stale");
    }
    const grants = await client.teamGrants(state.relay_token, sessionId, workItemId);
    if (grants?.contract_version !== 1 || grants.session_id !== sessionId
      || !Array.isArray(grants.grants) || grants.grants.length > MAX_ROWS) return fail("team_provider_grant_invalid");
    const grant = grants.grants.find((item) => item?.work_item_id === workItemId);
    if (!grant || grant.state !== "active" || grant.revision !== grantRevision
      || grant.claim_generation !== row.claim_generation || grant.policy_revision !== policyRevision) {
      return fail("team_provider_grant_stale");
    }
    const signed = verifyTeamGrantToken(grant, {
      sessionId, instanceId: grant.executor_instance_id,
      repositoryFingerprint: repositoryFingerprint(state.remote_url),
      branch: state.shared_branch, workItemId,
      signingPublicKey: grants.signing_public_key || grant.signing_public_key,
      kid: grants.kid || grant.kid,
    });
    if (!signed.ok || signed.claims.jti !== row.grant_jti) return fail("team_provider_grant_stale");
    const targetRef = `refs/heads/${state.shared_branch}`;
    const targetLine = git(projectDir, ["ls-remote", state.remote_name, targetRef]).trim();
    const [advertisedTarget, advertisedName] = targetLine.split(/\s+/u);
    if (advertisedName !== targetRef || advertisedTarget !== targetOid) {
      return fail("team_provider_refs_stale");
    }
    git(projectDir, ["fetch", "--no-tags", state.remote_name, targetRef]);
    if (git(projectDir, ["rev-parse", "--verify", "FETCH_HEAD"]).trim() !== targetOid
      || !fetchExact(projectDir, state.remote_name, row.workbranch_ref, row.source_oid)
      || !fetchExact(projectDir, state.remote_name, row.candidate_ref, candidateOid)) {
      return fail("team_provider_refs_stale");
    }
    const scope = verifyTeamGitScope({
      projectDir, targetOid, sourceOid: row.source_oid, candidateOid,
      effectivePermissions: grant.effective_permissions,
    });
    if (!scope.ok) return scope;
    const result = await createOrVerifyTeamPullRequest({
      projectDir, remoteUrl: state.remote_url, targetBranch: state.shared_branch,
      targetOid, candidateRef: row.candidate_ref, candidateOid,
    }, providerOptions);
    if (!result.ok) return result;
    return {
      ok: true,
      protocol: "posse.team_provider_pr.v1",
      repo_path: path.resolve(projectDir),
      session_id: sessionId,
      submission_id: submissionId,
      work_item_id: workItemId,
      source_oid: row.source_oid,
      target_oid: targetOid,
      candidate_oid: candidateOid,
      candidate_ref: row.candidate_ref,
      grant_revision: grantRevision,
      policy_revision: policyRevision,
      publication_revision: state.team_publication_revision,
      pull_number: result.pullNumber,
      review_url: result.url,
      protection: result.protection,
      ...(typeof actionId === "string" && actionId.length > 0 ? { action_id: actionId } : {}),
    };
  } catch {
    return fail("team_provider_unavailable");
  }
}

function exactReceipt(receipt, pins) {
  return receipt && Object.entries(pins).every(([key, value]) =>
    (key === "submission_id" ? (receipt.submission_id || receipt.id) : receipt[key]) === value);
}

/** Host-only provider publication. Remote's exact originator decision is
 * rechecked immediately before GitHub's head-pinned PR merge. The accepted
 * OID is GitHub's merge commit, not the local squash candidate OID. */
export async function publishApprovedTeamPullRequest(args = {}) {
  const prepared = await prepareTeamSubmissionPullRequest(args);
  // An already merged PR can outlive the old target ref after a lost response.
  // A separate read-only reconciler may inspect it; this write actuator does
  // not attempt another merge when the pinned target has moved.
  if (!prepared.ok) return prepared;
  const state = getLivePairingState();
  try {
    const client = (args.remoteClientFactory || createPairingRemoteClient)();
    const listed = await client.teamSubmissions(state.relay_token, state.remote_session_id);
    if (listed?.contract_version !== 1 || listed.session_id !== state.remote_session_id
      || !Array.isArray(listed.submissions) || listed.submissions.length > MAX_ROWS) {
      return fail("team_provider_submission_invalid");
    }
    const row = listed.submissions.find((item) => (item?.id || item?.submission_id) === args.submission_id);
    if (!row || row.state !== "approved" || row.work_item_id !== args.work_item_id
      || row.target_oid !== args.target_oid || row.candidate_oid !== args.candidate_oid
      || row.grant_revision !== args.grant_revision || row.policy_revision !== args.policy_revision
      || row.candidate_ref !== prepared.candidate_ref || row.source_oid !== prepared.source_oid) {
      return fail("team_provider_submission_stale");
    }
    const grants = await client.teamGrants(state.relay_token, state.remote_session_id, args.work_item_id);
    const grant = grants?.contract_version === 1 && grants.session_id === state.remote_session_id
      && Array.isArray(grants.grants) && grants.grants.length <= MAX_ROWS
      ? grants.grants.find((item) => item?.work_item_id === args.work_item_id) : null;
    if (!grant || grant.state !== "active" || grant.revision !== row.grant_revision
      || grant.originator_instance_id !== row.decision_actor_instance_id
      || !row.decision_action_id) return fail("team_provider_approval_stale");
    const pins = {
      submission_id: args.submission_id,
      work_item_id: args.work_item_id,
      grant_revision: row.grant_revision,
      grant_jti: row.grant_jti,
      claim_generation: row.claim_generation,
      source_oid: row.source_oid,
      target_oid: row.target_oid,
      candidate_oid: row.candidate_oid,
      result_oid: row.result_oid,
      policy_revision: row.policy_revision,
    };
    const checked = await client.checkTeamWorkbranch(state.relay_token, {
      ...pins, session_id: state.remote_session_id,
    });
    if (checked?.session_id !== state.remote_session_id || checked.approved !== true
      || !exactReceipt(checked.receipt, pins)
      || checked.receipt.decision_actor_instance_id !== grant.originator_instance_id
      || checked.receipt.decision_action_id !== row.decision_action_id) {
      return fail("team_provider_approval_stale");
    }
    const status = await client.status(state.relay_token);
    if (status?.session_id !== state.remote_session_id
      || status.team_publication_mode !== "github-pr"
      || status.team_publication_revision !== prepared.publication_revision
      || status.submission_approval_enabled !== true
      || status.submission_policy_revision !== row.policy_revision) {
      return fail("team_provider_policy_stale");
    }
    const providerInput = {
      projectDir: args.projectDir || process.cwd(), remoteUrl: state.remote_url,
      targetBranch: state.shared_branch, targetOid: args.target_oid,
      candidateRef: prepared.candidate_ref, candidateOid: args.candidate_oid,
      pullNumber: prepared.pull_number,
    };
    const located = await findTeamPullRequest(providerInput, args.providerOptions);
    if (!located.ok || !located.found || located.pullNumber !== prepared.pull_number) {
      return fail(located.reason || "team_provider_pull_request_stale");
    }
    if (located.merged) {
      const inspected = await inspectTeamPullRequestMerge(providerInput, args.providerOptions);
      if (!inspected.ok || !inspected.merged) return fail(inspected.reason || "github_merge_unverifiable");
      return { ...prepared, protocol: "posse.team_provider_publish.v1",
        accepted_oid: inspected.mergeOid, branch_oid: inspected.branchOid, merged: true, recovered: true };
    }
    const merged = await mergeApprovedTeamPullRequest(providerInput, args.providerOptions);
    if (!merged.ok) return merged;
    return { ...prepared, protocol: "posse.team_provider_publish.v1",
      accepted_oid: merged.mergeOid, branch_oid: merged.branchOid,
      merged: true, recovered: merged.recovered === true };
  } catch {
    return fail("team_provider_publication_unavailable");
  }
}
