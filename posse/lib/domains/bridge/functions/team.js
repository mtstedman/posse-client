import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getLivePairingState } from "../../pairing/functions/state.js";
import { cleanScopePath } from "../../pairing/functions/team-scope.js";
import {
  TEAM_SCOPE_LABEL_PATTERN,
  TEAM_SCOPE_LIMITS,
} from "../../../catalog/team.js";

import {
  TEAM_DECISION_PROTOCOL,
  TEAM_OVERVIEW_PROTOCOL,
  TEAM_PROVIDER_PR_PROTOCOL,
  TEAM_PROVIDER_PUBLISH_PROTOCOL,
  TEAM_PROVIDER_PROTECTION_PROTOCOL,
  TEAM_PROMOTION_PROTOCOL,
} from "../../../catalog/bridge.js";

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function repositoryPath(args, context) {
  const ownerPath = path.resolve(context.projectDir || process.cwd());
  if (typeof args?.repo_path !== "string"
      || !args.repo_path.trim()
      || path.resolve(args.repo_path) !== ownerPath) {
    return { ok: false, reason: "wrong_repository" };
  }
  return { ok: true, repoPath: ownerPath };
}

async function ownerFunctions(context) {
  return context.teamOwnerFunctions || import("../../pairing/functions/team-submissions.js");
}

async function providerFunctions(context) {
  return context.teamProviderFunctions || import("../../pairing/functions/team-provider-pr.js");
}

export async function approveTeamPromotion(args = {}, context = {}) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  const actionId = textId(args.action_id);
  const sessionId = textId(args.session_id);
  const sourceOid = String(args.source_oid || "");
  const originOid = String(args.origin_oid || "");
  if (!actionId || !sessionId || !OID_PATTERN.test(sourceOid) || !OID_PATTERN.test(originOid)) {
    return { ok: false, reason: "invalid_team_promotion_pins" };
  }
  const state = context.teamHostState || getLivePairingState();
  if (state?.role !== "host" || state.remote_session_id !== sessionId) {
    return { ok: false, reason: "team_promotion_host_required" };
  }
  const owner = context.teamPromotionFunctions || await import("../../pairing/functions/pair-command.js");
  if (typeof owner.approvePairingPromotion !== "function") {
    return { ok: false, reason: "team_promotion_unavailable" };
  }
  const result = await owner.approvePairingPromotion({ projectDir: repo.repoPath,
    session_id: sessionId, source_oid: sourceOid, origin_oid: originOid, action_id: actionId });
  if (result?.ok === false) return result;
  if (result?.protocol !== TEAM_PROMOTION_PROTOCOL || result.repo_path !== repo.repoPath
      || result.session_id !== sessionId || result.action_id !== actionId
      || result.source_oid !== sourceOid || result.origin_oid !== originOid
      || result.published_oid !== sourceOid) {
    return { ok: false, reason: "invalid_team_promotion_receipt" };
  }
  return result;
}

function textId(value) {
  const text = String(value ?? "").trim();
  return text && text.length <= 128 ? text : null;
}

function nonnegativeRevision(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function decisionArgs(args) {
  const ids = ["action_id", "session_id", "work_item_id", "submission_id"];
  const revisions = ["grant_revision", "policy_revision"];
  const oids = ["target_oid", "candidate_oid"];
  const normalized = {};
  for (const key of ids) {
    normalized[key] = textId(args[key]);
    if (!normalized[key]) return null;
  }
  for (const key of revisions) {
    normalized[key] = nonnegativeRevision(args[key]);
    if (normalized[key] == null) return null;
  }
  for (const key of oids) {
    normalized[key] = String(args[key] ?? "");
    if (!OID_PATTERN.test(normalized[key])) return null;
  }
  if (!(["approve", "deny"].includes(args.decision))) return null;
  normalized.decision = args.decision;
  if (args.feedback != null) {
    const feedback = String(args.feedback).trim();
    if (feedback.length > 2000) return null;
    normalized.feedback = feedback;
  }
  return normalized;
}

function validPermissionGroup(group) {
  const write = group?.write;
  const tools = group?.tools ?? [];
  const database = group?.database ?? [];
  const budget = group?.budget;
  return group && typeof group === "object" && !Array.isArray(group)
    && write && write.unknown === false
    && Array.isArray(write.files) && Array.isArray(write.roots)
    && Array.isArray(tools) && Array.isArray(database)
    && write.files.length + write.roots.length + tools.length + database.length > 0
    && write.files.length <= TEAM_SCOPE_LIMITS.MAX_WRITE_ENTRIES
    && write.roots.length <= TEAM_SCOPE_LIMITS.MAX_WRITE_ENTRIES
    // Apply the canonical scope-path rule at the boundary itself. Checking
    // only type and length here read as validation while forwarding traversal,
    // absolute, glob and control-character paths to the owner to reject.
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

function normalizedPermissionGroup(group) {
  return {
    write: {
      files: [...(group?.write?.files || [])].sort(),
      roots: [...(group?.write?.roots || [])].sort(),
      unknown: group?.write?.unknown,
    },
    tools: [...(group?.tools || [])].sort(),
    database: [...(group?.database || [])].sort(),
    budget: group?.budget ?? null,
  };
}

function grantBaseArgs(args) {
  const sessionId = textId(args.session_id);
  const expectedRevision = nonnegativeRevision(args.expected_revision);
  const expiresAt = String(args.expires_at || "");
  if (!sessionId || expectedRevision == null
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(expiresAt)
      || !Number.isFinite(Date.parse(expiresAt))) return null;
  return { session_id: sessionId, expected_revision: expectedRevision, expires_at: expiresAt };
}

export async function projectTeamOverview(args = {}, context = {}) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  const owner = await ownerFunctions(context);
  if (typeof owner.projectTeamOverview !== "function") {
    return { ok: false, reason: "team_unavailable" };
  }
  const result = await owner.projectTeamOverview({
    repo_path: repo.repoPath,
    projectDir: repo.repoPath,
  });
  if (result?.ok === false) return result;
  if (result?.protocol !== TEAM_OVERVIEW_PROTOCOL
      || typeof result.repo_path !== "string"
      || path.resolve(result.repo_path) !== repo.repoPath
      || !textId(result.session_id)
      || (result.trunk_oid != null && !OID_PATTERN.test(result.trunk_oid))
      || !Number.isFinite(Date.parse(result.observed_at))
      || nonnegativeRevision(result.revision) == null
      || !Array.isArray(result.members)
      || result.members.length > 100
      || !Array.isArray(result.submissions)
      || result.submissions.length > 100
      || !Array.isArray(result.capabilities)
      || result.capabilities.length > 32) {
    return { ok: false, reason: "invalid_team_projection" };
  }
  return result;
}

export async function decideTeamSubmission(args = {}, context = {}) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  const decision = decisionArgs(args);
  if (!decision) return { ok: false, reason: "invalid_team_decision" };
  const owner = await ownerFunctions(context);
  if (typeof owner.decideTeamSubmission !== "function") {
    return { ok: false, reason: "team_unavailable" };
  }
  const result = await owner.decideTeamSubmission({
    ...decision,
    repo_path: repo.repoPath,
    projectDir: repo.repoPath,
    actor: context.actor || "bridge",
  });
  if (result?.ok === false) return result;
  if (result?.protocol !== TEAM_DECISION_PROTOCOL
      || result.repo_path !== repo.repoPath
      || Object.entries(decision).some(([key, value]) =>
        key !== "feedback" && String(result[key]) !== String(value))) {
    return { ok: false, reason: "invalid_team_decision_receipt" };
  }
  return result;
}

export async function setTeamPolicy(args = {}, context = {}) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  if (typeof args.enabled !== "boolean") {
    return { ok: false, reason: "invalid_team_policy" };
  }
  const actionId = textId(args.action_id);
  if (!actionId) return { ok: false, reason: "invalid_action_id" };
  const owner = await ownerFunctions(context);
  if (typeof owner.setTeamSubmissionApproval !== "function") {
    return { ok: false, reason: "team_unavailable" };
  }
  const result = await owner.setTeamSubmissionApproval(args.enabled, {
    repo_path: repo.repoPath,
    projectDir: repo.repoPath,
    actor: context.actor || "bridge",
    action_id: actionId,
  });
  if (result?.ok === false) return result;
  if (result?.protocol !== "posse.team_policy.v1"
      || result.repo_path !== repo.repoPath
      || result.action_id !== actionId
      || result.enabled !== args.enabled
      || nonnegativeRevision(result.revision) == null) {
    return { ok: false, reason: "invalid_team_policy_receipt" };
  }
  return result;
}

export async function requestTeamGrant(args = {}, context = {}) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  const base = grantBaseArgs(args);
  const localWorkItemId = Number(args.local_work_item_id);
  if (!base || !Number.isSafeInteger(localWorkItemId) || localWorkItemId < 1
      || !validPermissionGroup(args.requested_permissions)) {
    return { ok: false, reason: "invalid_grant_request" };
  }
  const owner = await ownerFunctions(context);
  if (typeof owner.requestTeamGrant !== "function") {
    return { ok: false, reason: "team_unavailable" };
  }
  const result = await owner.requestTeamGrant({
    ...base,
    local_work_item_id: localWorkItemId,
    requested_permissions: args.requested_permissions,
    projectDir: repo.repoPath,
    actor: context.actor || "bridge",
  });
  if (result?.ok === false) return result;
  if (result?.protocol !== "posse.team_grant_request.v1"
      || result.repo_path !== repo.repoPath
      || result.session_id !== base.session_id
      || !textId(result.work_item_id)
      || nonnegativeRevision(result.requested_revision) == null) {
    return { ok: false, reason: "invalid_grant_request_receipt" };
  }
  return result;
}

export async function issueTeamGrant(args = {}, context = {}) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  const base = grantBaseArgs(args);
  const ids = ["action_id", "work_item_id", "executor_instance_id", "originator_instance_id"];
  const pins = {};
  for (const key of ids) {
    pins[key] = textId(args[key]);
    if (!pins[key]) return { ok: false, reason: "invalid_grant_issue" };
  }
  pins.policy_revision = nonnegativeRevision(args.policy_revision);
  pins.claim_generation = nonnegativeRevision(args.claim_generation);
  if (!base || pins.policy_revision == null || pins.claim_generation == null
      || !["active", "waiting_for_files"].includes(args.state)
      || !validPermissionGroup(args.effective_permissions)) {
    return { ok: false, reason: "invalid_grant_issue" };
  }
  const owner = await ownerFunctions(context);
  if (typeof owner.issueTeamGrant !== "function") {
    return { ok: false, reason: "team_unavailable" };
  }
  const request = {
    ...base,
    ...pins,
    state: args.state,
    effective_permissions: args.effective_permissions,
    projectDir: repo.repoPath,
    actor: context.actor || "bridge",
  };
  const result = await owner.issueTeamGrant(request);
  if (result?.ok === false) return result;
  if (result?.protocol !== "posse.team_grant_issue.v1"
      || result.repo_path !== repo.repoPath
      || result.session_id !== base.session_id
      || result.expected_revision !== base.expected_revision
      || result.grant_revision !== base.expected_revision + 1
      || result.expires_at !== base.expires_at
      || result.state !== request.state
      || Object.entries(pins).some(([key, value]) => String(result[key]) !== String(value))
      || !isDeepStrictEqual(normalizedPermissionGroup(result.effective_permissions),
        normalizedPermissionGroup(request.effective_permissions))) {
    return { ok: false, reason: "invalid_grant_issue_receipt" };
  }
  return result;
}

function providerPrPins(args) {
  const normalized = {};
  for (const key of ["action_id", "session_id", "submission_id", "work_item_id"]) {
    normalized[key] = textId(args[key]);
    if (!normalized[key]) return null;
  }
  for (const key of ["target_oid", "candidate_oid"]) {
    normalized[key] = String(args[key] || "");
    if (!OID_PATTERN.test(normalized[key])) return null;
  }
  for (const key of ["grant_revision", "policy_revision"]) {
    normalized[key] = nonnegativeRevision(args[key]);
    if (normalized[key] == null) return null;
  }
  if (normalized.grant_revision === 0) return null;
  return normalized;
}

function validProviderReceipt(result, pins, repoPath, protocol, publish) {
  if (result?.protocol !== protocol || result.repo_path !== repoPath
      || Object.entries(pins).some(([key, value]) => result[key] !== value)
      || !OID_PATTERN.test(result.source_oid || "")
      || !OID_PATTERN.test(result.protection?.observedOid || "")
      || result.protection.observedOid !== pins.target_oid
      || result.protection.mode !== "github_pr_protected"
      || typeof result.protection.branch !== "string" || !result.protection.branch
      || !/^refs\/heads\/posse\/team\/[A-Za-z0-9._/-]{1,160}\/candidate$/u.test(result.candidate_ref || "")
      || !Number.isSafeInteger(result.pull_number) || result.pull_number <= 0
      || nonnegativeRevision(result.publication_revision) == null) return false;
  try {
    const url = new URL(result.review_url);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password
      || !url.pathname.endsWith(`/pull/${result.pull_number}`)) return false;
  } catch { return false; }
  return publish
    ? result.merged === true && typeof result.recovered === "boolean"
      && OID_PATTERN.test(result.accepted_oid || "") && OID_PATTERN.test(result.branch_oid || "")
    : true;
}

async function runProviderPrAction(args, context, publish) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  const pins = providerPrPins(args);
  if (!pins) return { ok: false, reason: "invalid_team_provider_pins" };
  const state = context.teamHostState || getLivePairingState();
  if (state?.phase !== "active" || state.role !== "host"
    || state.remote_session_id !== pins.session_id
    || state.submission_approval_enabled !== 1 || state.team_publication_mode !== "github-pr") {
    return { ok: false, reason: "team_provider_host_required" };
  }
  const owner = await providerFunctions(context);
  const fn = publish ? owner.publishApprovedTeamPullRequest : owner.prepareTeamSubmissionPullRequest;
  if (typeof fn !== "function") return { ok: false, reason: "team_provider_unavailable" };
  const result = await fn({ ...pins, repo_path: repo.repoPath, projectDir: repo.repoPath });
  if (result?.ok === false) return result;
  const protocol = publish ? TEAM_PROVIDER_PUBLISH_PROTOCOL : TEAM_PROVIDER_PR_PROTOCOL;
  if (!validProviderReceipt(result, pins, repo.repoPath, protocol, publish)) {
    return { ok: false, reason: "invalid_team_provider_receipt" };
  }
  return result;
}

export function prepareTeamProviderPullRequest(args = {}, context = {}) {
  return runProviderPrAction(args, context, false);
}

export function publishTeamProviderPullRequest(args = {}, context = {}) {
  return runProviderPrAction(args, context, true);
}

export async function configureTeamProviderProtection(args = {}, context = {}) {
  const repo = repositoryPath(args, context);
  if (!repo.ok) return repo;
  const actionId = textId(args.action_id);
  const sessionId = textId(args.session_id);
  const targetOid = String(args.target_oid || "");
  const checkContext = args.required_check_context;
  const appId = args.required_check_app_id;
  if (!actionId || !sessionId || !OID_PATTERN.test(targetOid)
      || typeof checkContext !== "string" || checkContext.length < 2 || checkContext.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9 ._:/()\-]*$/u.test(checkContext)
      || !Number.isSafeInteger(appId) || appId <= 0) {
    return { ok: false, reason: "invalid_team_provider_protection" };
  }
  const state = context.teamHostState || getLivePairingState();
  if (state?.phase !== "active" || state.role !== "host"
      || state.remote_session_id !== sessionId || state.submission_approval_enabled !== 1
      || !["direct", "github-pr"].includes(state.team_publication_mode)) {
    return { ok: false, reason: "team_provider_host_required" };
  }
  const owner = await providerFunctions(context);
  if (typeof owner.configureHostTeamBranchProtection !== "function") {
    return { ok: false, reason: "team_provider_unavailable" };
  }
  const result = await owner.configureHostTeamBranchProtection({
    projectDir: repo.repoPath, repo_path: repo.repoPath,
    action_id: actionId, session_id: sessionId, target_oid: targetOid,
    required_check_context: checkContext, required_check_app_id: appId,
  });
  if (result?.ok === false) return result;
  if (result?.protocol !== TEAM_PROVIDER_PROTECTION_PROTOCOL
      || result.repo_path !== repo.repoPath || result.action_id !== actionId
      || result.session_id !== sessionId || result.target_oid !== targetOid
      || result.required_check_context !== checkContext || result.required_check_app_id !== appId
      || nonnegativeRevision(result.publication_revision) == null
      || result.protection?.mode !== "github_pr_protected"
      || result.protection.observedOid !== targetOid || typeof result.protection.branch !== "string"
      || !result.protection.branch) {
    return { ok: false, reason: "invalid_team_provider_protection_receipt" };
  }
  return result;
}
