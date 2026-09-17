/** Remote is authoritative for Team approval policy, but it may never walk that
 * policy backwards. A relay that stops reporting an enabled policy, or reports
 * an older policy revision, is stale or lying; either way local enforcement
 * must not follow it down, because a rolled-back revision would make grants
 * issued under the old revision match again.
 *
 * Both the scheduler session monitor and the foreground `posse session` loop
 * sync this policy. They are separate loops over the same fields, so the rule
 * lives here once rather than in whichever copy someone remembered to guard.
 *
 * @returns {string | null} a regression reason, or null when the reported
 * policy is a safe successor of the local one.
 */
export function teamPolicyRegression(state, status) {
  const priorRevision = Number(state?.submission_approval_revision) || 0;
  const enabledLocally = Number(state?.submission_approval_enabled) === 1;
  if (status?.submission_approval_enabled == null) {
    return enabledLocally ? "team_policy_omitted" : null;
  }
  const revision = status.submission_policy_revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    return "team_policy_revision_invalid";
  }
  if (revision < priorRevision) return "team_policy_revision_regressed";
  if (revision === priorRevision && status.submission_approval_enabled !== enabledLocally) {
    return "team_policy_flipped_without_revision";
  }
  return null;
}

export const TEAM_POLICY_REGRESSION_MESSAGES = Object.freeze({
  team_policy_omitted: "Session relay omitted the active Team approval policy",
  team_policy_revision_invalid: "Session relay reported an invalid Team approval policy revision",
  team_policy_revision_regressed: "Session Team approval policy revision moved backwards",
  team_policy_flipped_without_revision: "Session Team approval policy changed without a new revision",
});

export function teamPolicyRegressionMessage(reason) {
  return TEAM_POLICY_REGRESSION_MESSAGES[reason] || "Session Team approval policy regressed";
}
