import { execFileSync } from "node:child_process";

import { githubRepositoryName } from "./github-session.js";

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const CANDIDATE_REF_RE = /^refs\/heads\/posse\/team\/[A-Za-z0-9._/-]{1,160}\/candidate$/u;

function fail(reason) { return { ok: false, reason }; }

function validBranch(branch) {
  return typeof branch === "string" && BRANCH_RE.test(branch)
    && !branch.includes("..") && !branch.includes("//")
    && !branch.endsWith("/") && !branch.endsWith(".lock");
}

function context(input) {
  let repository;
  try { repository = githubRepositoryName(input?.remoteUrl); } catch { repository = null; }
  if (!repository || !validBranch(input?.targetBranch)) return null;
  return { repository, owner: repository.split("/")[0], branch: input.targetBranch };
}

function defaultApi(projectDir) {
  return (endpoint, { method = "GET", fields = {}, body = null } = {}) => {
    const args = ["api", "-H", "Accept: application/vnd.github+json", endpoint];
    if (method !== "GET") args.push("--method", method);
    if (body != null) args.push("--input", "-");
    for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
    const output = execFileSync("gh", args, {
      cwd: projectDir,
      encoding: "utf8",
      stdio: [body == null ? "ignore" : "pipe", "pipe", "pipe"],
      ...(body == null ? {} : { input: JSON.stringify(body) }),
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(output);
  };
}

/** Host setup requires an explicitly chosen CI identity. GitHub's admin
 * permission and exact branch OID are checked before the protection mutation;
 * the rule is accepted only after a fresh read verifies every required gate. */
export async function configureProtectedTeamBranch({
  projectDir, remoteUrl, targetBranch, expectedTargetOid,
  requiredCheckContext, requiredCheckAppId,
} = {}, options = {}) {
  const parsed = context({ remoteUrl, targetBranch });
  if (!parsed || !OID_RE.test(expectedTargetOid || "")
    || typeof requiredCheckContext !== "string" || requiredCheckContext.length < 2
    || requiredCheckContext.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9 ._:/()\-]*$/u.test(requiredCheckContext)
    || !Number.isSafeInteger(requiredCheckAppId) || requiredCheckAppId <= 0) {
    return fail("github_protection_configuration_invalid");
  }
  try {
    const api = apiFor(projectDir, options);
    const repository = await api(`repos/${parsed.repository}`);
    if (repository?.full_name !== parsed.repository || repository.permissions?.admin !== true) {
      return fail("github_admin_required");
    }
    const branch = await api(branchEndpoint(parsed.repository, parsed.branch));
    if (branch?.name !== parsed.branch || branch?.commit?.sha !== expectedTargetOid) {
      return fail("github_target_moved");
    }
    if (branch.protected === true) {
      // Replacing an existing rule could remove unrelated protections. Accept
      // it only if it already meets this exact policy and required check.
      const existing = await verifyProtectedTeamBranch({ projectDir, remoteUrl, targetBranch }, options);
      if (!existing.ok || existing.protection.observedOid !== expectedTargetOid) {
        return fail("github_existing_protection_requires_review");
      }
      const current = await api(`${branchEndpoint(parsed.repository, parsed.branch)}/protection`);
      const checks = current?.required_status_checks?.checks;
      if (!Array.isArray(checks) || !checks.some((check) =>
        check?.context === requiredCheckContext && check.app_id === requiredCheckAppId)) {
        return fail("github_existing_protection_requires_review");
      }
      return { ok: true, protection: existing.protection,
        requiredCheckContext, requiredCheckAppId, existing: true };
    }
    if (branch.protected !== false) return fail("github_branch_protection_unknown");
    const body = {
      required_status_checks: { strict: true, checks: [{ context: requiredCheckContext, app_id: requiredCheckAppId }] },
      enforce_admins: true,
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        required_approving_review_count: 1,
        require_last_push_approval: true,
        bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      lock_branch: false,
    };
    await api(`${branchEndpoint(parsed.repository, parsed.branch)}/protection`, { method: "PUT", body });
    const verified = await verifyProtectedTeamBranch({ projectDir, remoteUrl, targetBranch }, options);
    if (!verified.ok) return verified;
    if (verified.protection.observedOid !== expectedTargetOid) return fail("github_target_moved");
    const reread = await api(`${branchEndpoint(parsed.repository, parsed.branch)}/protection`);
    const checks = reread?.required_status_checks?.checks;
    if (!Array.isArray(checks) || !checks.some((check) =>
      check?.context === requiredCheckContext && check.app_id === requiredCheckAppId)) {
      return fail("github_required_check_mismatch");
    }
    return { ok: true, protection: verified.protection,
      requiredCheckContext, requiredCheckAppId };
  } catch {
    return fail("github_protection_configuration_unavailable");
  }
}

function apiFor(projectDir, options) { return options?.api || defaultApi(projectDir); }

function defaultGraphql(projectDir) {
  return (query, variables) => JSON.parse(execFileSync("gh", ["api", "graphql", "--method", "POST", "--input", "-"], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: JSON.stringify({ query, variables }),
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  }));
}

async function noPullRequestBypass(protection, parsed, projectDir, options) {
  const bypass = protection?.required_pull_request_reviews?.bypass_pull_request_allowances;
  if (bypass != null) {
    return ["users", "teams", "apps"].every((key) => Array.isArray(bypass[key]) && bypass[key].length === 0);
  }
  // REST sometimes omits the allowance collection. GraphQL exposes the
  // effective classic branch rule's total allowance count; unknown fails.
  const graphql = options?.graphql || defaultGraphql(projectDir);
  const query = "query($owner:String!,$name:String!,$qualifiedName:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$qualifiedName){branchProtectionRule{bypassPullRequestAllowances(first:1){totalCount}}}}}";
  const result = await graphql(query, {
    owner: parsed.owner,
    name: parsed.repository.split("/")[1],
    qualifiedName: `refs/heads/${parsed.branch}`,
  });
  return result?.data?.repository?.ref?.branchProtectionRule?.bypassPullRequestAllowances?.totalCount === 0;
}

function branchEndpoint(repository, branch) {
  return `repos/${repository}/branches/${encodeURIComponent(branch)}`;
}

function expectedPull(pull, { repository, branch, candidateBranch, candidateOid, targetOid }) {
  return Number.isSafeInteger(pull?.number) && pull.number > 0
    && pull.base?.repo?.full_name === repository && pull.head?.repo?.full_name === repository
    && pull.base?.ref === branch && pull.base?.sha === targetOid
    && pull.head?.ref === candidateBranch && pull.head?.sha === candidateOid;
}

function pullResult(pull, repository) {
  return {
    ok: true,
    pullNumber: pull.number,
    url: `https://github.com/${repository}/pull/${pull.number}`,
    headOid: pull.head.sha,
    baseOid: pull.base.sha,
  };
}

/** Locate a previous PR without creating one. This also works after the
 * target has advanced, allowing a lost merge response to be reconciled. */
export async function findTeamPullRequest(input, options = {}) {
  const parsed = context(input);
  const candidateRef = input?.candidateRef;
  if (!parsed || !CANDIDATE_REF_RE.test(candidateRef || "") || candidateRef.includes("..")
    || !OID_RE.test(input?.candidateOid || "")) return fail("github_pull_request_pins_invalid");
  const candidateBranch = candidateRef.slice("refs/heads/".length);
  try {
    const api = apiFor(input.projectDir, options);
    const listing = `repos/${parsed.repository}/pulls?state=all&head=${encodeURIComponent(`${parsed.owner}:${candidateBranch}`)}&base=${encodeURIComponent(parsed.branch)}&per_page=100`;
    const existing = await api(listing);
    if (!Array.isArray(existing) || existing.length > 100) return fail("github_pull_request_list_invalid");
    if (existing.length === 0) return { ok: true, found: false };
    if (existing.length !== 1 || !Number.isSafeInteger(existing[0]?.number)) return fail("github_pull_request_ambiguous");
    const pull = await api(`repos/${parsed.repository}/pulls/${existing[0].number}`);
    if (pull.number !== existing[0].number
      || pull.base?.repo?.full_name !== parsed.repository || pull.head?.repo?.full_name !== parsed.repository
      || pull.base?.ref !== parsed.branch || pull.head?.ref !== candidateBranch
      || pull.head?.sha !== input.candidateOid) return fail("github_pull_request_stale");
    return { ok: true, found: true, pullNumber: pull.number,
      url: `https://github.com/${parsed.repository}/pull/${pull.number}`,
      state: pull.state, merged: pull.merged === true };
  } catch {
    return fail("github_pull_request_unavailable");
  }
}

function protectedReviewPolicy(protection, noBypass) {
  const reviews = protection?.required_pull_request_reviews;
  const checks = protection?.required_status_checks;
  // A strict check must be pinned to an installed App. A collaborator with
  // write access can otherwise forge an ordinary commit status.
  const pinnedChecks = Array.isArray(checks?.checks) && checks.checks.some((check) =>
    typeof check?.context === "string" && check.context.length > 0
    && Number.isSafeInteger(check.app_id) && check.app_id > 0);
  return Boolean(reviews && checks && noBypass && pinnedChecks
    && reviews.required_approving_review_count >= 1
    && reviews.dismiss_stale_reviews === true
    && reviews.require_last_push_approval === true
    && checks.strict === true
    && protection?.enforce_admins?.enabled === true
    && protection?.allow_force_pushes?.enabled !== true
    && protection?.allow_deletions?.enabled !== true
    && protection?.lock_branch?.enabled !== true
    && protection?.required_linear_history?.enabled !== true);
}

/** Read-only proof that a GitHub branch presently rejects ordinary direct
 * pushes and requires fresh PR review plus an App-pinned, strict CI check.
 * This proof is intentionally re-read before creation and merge. */
export async function verifyProtectedTeamBranch(input, options = {}) {
  const parsed = context(input);
  if (!parsed) return fail("github_repository_invalid");
  try {
    const api = apiFor(input.projectDir, options);
    const branch = await api(branchEndpoint(parsed.repository, parsed.branch));
    if (branch?.name !== parsed.branch || branch?.protected !== true || !OID_RE.test(branch?.commit?.sha || "")) {
      return fail("github_branch_unprotected");
    }
    const protection = await api(`${branchEndpoint(parsed.repository, parsed.branch)}/protection`);
    const noBypass = await noPullRequestBypass(protection, parsed, input.projectDir, options);
    if (!protectedReviewPolicy(protection, noBypass)) return fail("github_pr_protection_insufficient");
    return {
      ok: true,
      protection: { mode: "github_pr_protected", branch: parsed.branch, observedOid: branch.commit.sha },
    };
  } catch {
    return fail("github_protection_unavailable");
  }
}

/** Idempotently create the reviewable PR for the exact submitted candidate.
 * The branch refs must already have been pushed and verified by the caller. */
export async function createOrVerifyTeamPullRequest(input, options = {}) {
  const parsed = context(input);
  const candidateRef = input?.candidateRef;
  if (!parsed || !CANDIDATE_REF_RE.test(candidateRef || "") || candidateRef.includes("..")
    || !OID_RE.test(input?.targetOid || "") || !OID_RE.test(input?.candidateOid || "")) {
    return fail("github_pull_request_pins_invalid");
  }
  const protection = await verifyProtectedTeamBranch(input, options);
  if (!protection.ok) return protection;
  if (protection.protection.observedOid !== input.targetOid) return fail("github_target_moved");
  const candidateBranch = candidateRef.slice("refs/heads/".length);
  const api = apiFor(input.projectDir, options);
  const pins = {
    repository: parsed.repository, branch: parsed.branch, candidateBranch,
    candidateOid: input.candidateOid, targetOid: input.targetOid,
  };
  const listing = `repos/${parsed.repository}/pulls?state=all&head=${encodeURIComponent(`${parsed.owner}:${candidateBranch}`)}&base=${encodeURIComponent(parsed.branch)}&per_page=100`;
  try {
    const existing = await api(listing);
    if (!Array.isArray(existing) || existing.length > 100) return fail("github_pull_request_list_invalid");
    if (existing.length > 1) return fail("github_pull_request_ambiguous");
    if (existing.length === 1) {
      const pull = await api(`repos/${parsed.repository}/pulls/${existing[0].number}`);
      if (pull.number !== existing[0].number || pull.state !== "open" || !expectedPull(pull, pins)) {
        return fail("github_pull_request_stale");
      }
      return { ...pullResult(pull, parsed.repository), protection: protection.protection };
    }
    const created = await api(`repos/${parsed.repository}/pulls`, {
      method: "POST",
      fields: {
        title: `Posse team candidate ${input.candidateOid.slice(0, 12)}`,
        body: `Posse temporary-trunk submission.\n\nTarget OID: ${input.targetOid}\nCandidate OID: ${input.candidateOid}\nReview and approve the exact candidate before merge.`,
        head: candidateBranch,
        base: parsed.branch,
      },
    });
    const pull = await api(`repos/${parsed.repository}/pulls/${created?.number}`);
    if (pull.number !== created?.number || pull.state !== "open" || !expectedPull(pull, pins)) {
      return fail("github_pull_request_stale");
    }
    return { ...pullResult(pull, parsed.repository), protection: protection.protection };
  } catch {
    // POST may have succeeded before the response was lost. The caller parks;
    // the next attempt discovers the exact PR through the idempotent listing.
    return fail("github_pull_request_unavailable");
  }
}

/** Inspect an uncertain merge without issuing another write. GitHub's merge
 * commit must have the approved target and candidate as its two parents. */
export async function inspectTeamPullRequestMerge(input, options = {}) {
  const parsed = context(input);
  if (!parsed || !Number.isSafeInteger(input?.pullNumber) || input.pullNumber <= 0
    || !OID_RE.test(input?.targetOid || "") || !OID_RE.test(input?.candidateOid || "")) {
    return fail("github_pull_request_pins_invalid");
  }
  try {
    const api = apiFor(input.projectDir, options);
    const pull = await api(`repos/${parsed.repository}/pulls/${input.pullNumber}`);
    const candidateBranch = input.candidateRef?.slice("refs/heads/".length);
    if (!candidateBranch || !CANDIDATE_REF_RE.test(input.candidateRef)
      || pull.number !== input.pullNumber
      || pull.base?.repo?.full_name !== parsed.repository || pull.head?.repo?.full_name !== parsed.repository
      || pull.base?.ref !== parsed.branch || pull.head?.ref !== candidateBranch
      || pull.head?.sha !== input.candidateOid) return fail("github_pull_request_stale");
    if (pull.merged !== true) return { ok: true, merged: false, pullNumber: pull.number };
    const mergeOid = pull.merge_commit_sha;
    if (!OID_RE.test(mergeOid || "")) return fail("github_merge_unverifiable");
    const commit = await api(`repos/${parsed.repository}/git/commits/${mergeOid}`);
    if (commit?.sha !== mergeOid || commit?.parents?.length !== 2
      || commit.parents[0]?.sha !== input.targetOid || commit.parents[1]?.sha !== input.candidateOid) {
      return fail("github_merge_parents_mismatch");
    }
    const branch = await api(branchEndpoint(parsed.repository, parsed.branch));
    const branchOid = branch?.commit?.sha;
    if (!OID_RE.test(branchOid || "")) return fail("github_merge_unverifiable");
    if (branchOid !== mergeOid) {
      const comparison = await api(`repos/${parsed.repository}/compare/${mergeOid}...${branchOid}`);
      if (!comparison || !["ahead", "identical"].includes(comparison.status)) return fail("github_merge_not_on_target");
    }
    return { ok: true, merged: true, mergeOid, branchOid, pullNumber: pull.number,
      url: `https://github.com/${parsed.repository}/pull/${pull.number}` };
  } catch {
    return fail("github_merge_unavailable");
  }
}

/** Read-only host proof for an accepted handoff. Discover the PR from the
 * immutable candidate ref instead of trusting a caller-supplied PR number. */
export async function verifyPublishedTeamPullRequest({
  projectDir, submission, remoteUrl, targetBranch,
} = {}, options = {}) {
  const input = {
    projectDir, remoteUrl, targetBranch,
    targetOid: submission?.target_oid,
    candidateOid: submission?.candidate_oid,
    candidateRef: submission?.candidate_ref,
  };
  if (!OID_RE.test(input.targetOid || "")) return fail("github_pull_request_pins_invalid");
  const found = await findTeamPullRequest(input, options);
  if (!found.ok) return found;
  if (!found.found) return fail("github_pull_request_missing");
  const inspected = await inspectTeamPullRequestMerge({ ...input, pullNumber: found.pullNumber }, options);
  if (!inspected.ok) return inspected;
  if (!inspected.merged) return fail("github_pull_request_unmerged");
  return { ok: true, acceptedOid: inspected.mergeOid, branchOid: inspected.branchOid,
    pullNumber: found.pullNumber, url: inspected.url };
}

/** Merge only after Posse's exact originator decision gate passed. GitHub's
 * merge endpoint pins the PR head; strict status checks protect base freshness. */
export async function mergeApprovedTeamPullRequest(input, options = {}) {
  const parsed = context(input);
  if (!parsed || !Number.isSafeInteger(input?.pullNumber) || input.pullNumber <= 0
    || !CANDIDATE_REF_RE.test(input?.candidateRef || "") || input.candidateRef.includes("..")
    || !OID_RE.test(input?.targetOid || "") || !OID_RE.test(input?.candidateOid || "")) {
    return fail("github_pull_request_pins_invalid");
  }
  const protection = await verifyProtectedTeamBranch(input, options);
  if (!protection.ok) return protection;
  if (protection.protection.observedOid !== input.targetOid) return fail("github_target_moved");
  let reportedMergeOid = null;
  try {
    const api = apiFor(input.projectDir, options);
    const pull = await api(`repos/${parsed.repository}/pulls/${input.pullNumber}`);
    if (pull.state !== "open" || !expectedPull(pull, {
      repository: parsed.repository, branch: parsed.branch,
      candidateBranch: input.candidateRef?.slice("refs/heads/".length),
      candidateOid: input.candidateOid, targetOid: input.targetOid,
    })) return fail("github_pull_request_stale");
    const freshTarget = await api(branchEndpoint(parsed.repository, parsed.branch));
    if (freshTarget?.commit?.sha !== input.targetOid) return fail("github_target_moved");
    const merged = await api(`repos/${parsed.repository}/pulls/${input.pullNumber}/merge`, {
      method: "PUT",
      fields: { sha: input.candidateOid, merge_method: "merge" },
    });
    if (merged?.merged !== true || !OID_RE.test(merged.sha || "")) return fail("github_merge_rejected");
    reportedMergeOid = merged.sha;
  } catch {
    const observed = await inspectTeamPullRequestMerge(input, options);
    return observed.ok && observed.merged ? { ...observed, recovered: true, protection: protection.protection }
      : { ok: false, reason: observed.ok ? "github_merge_rejected" : observed.reason, publishUnknown: !observed.ok };
  }
  const observed = await inspectTeamPullRequestMerge(input, options);
  return observed.ok && observed.merged && observed.mergeOid === reportedMergeOid
    ? { ...observed, protection: protection.protection }
    : { ok: false, reason: observed.reason || "github_merge_unverifiable", publishUnknown: true };
}
