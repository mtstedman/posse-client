// Operator review before auto-merging work whose verification was waived.
//
// A planner test command that already fails before the change (baseline debt,
// recorded on the job by worker/functions/helpers/baseline-test-debt.js)
// cannot show that the change works: the assessor judges the diff, and a
// verification replan swaps in a command that runs but may check something
// else. Live 2026-10-01, WI 168: a risk-5 public-login change planned
// `php tests/api-smoke.php`, which fails on main for unrelated reasons; the
// replan swapped in a UX check that it said "is not evidence of
// database-backed authentication", a fix passed `npm run typecheck`, and
// auto-merge shipped +154 lines of Application.php with no executed backend
// check.
//
// So when a job's planned verification was waived or replaced this way and
// that job is high-risk (risk >= MERGE_REVIEW_MIN_RISK) or touches
// auth/session/security code, automatic merge authorization stops. A
// merge_verification_review gate keeps the work item in pending_review,
// visible to the bridge gate list, and names the replaced verification and
// why. "pass" lets the next automatic merge (or the approving review) merge
// it; "fail" sends the work item back through the review-rejection requeue
// with the operator's feedback (worker/functions/execution/
// merge-verification-answer.js), and the gate stops holding: the reworked
// work item is reviewed again with a new gate. The gate belongs to the
// completed work item, like a push offer: it does not reopen the work item or
// hold the run, and the merge retires it.
//
// Waived: a dev/fix job carries a baseline-debt record (its planned command
// failed before it changed anything). Replaced: a replan that carried
// baseline debt planned dev/fix jobs with a different test command. A fix
// continues the verification of the job it fixes, so the fix chain below a
// waived or replaced job counts as waived or replaced too. Only delivered
// jobs count -- what the merge ships: a succeeded (or accepted) job, or one
// whose commit is on the branch (a failed job a fix completed or a replan
// built on). Canceled or failed work that committed nothing does not, nor
// does canceled work at all: a job a rebuild or review rejection superseded
// (_superseded_by_replan) committed to a branch that was deleted, and a
// replan's cancel drops the job from the plan.
// Sensitive scope is a simple word match on those jobs only: a planned path
// or risk tag contains a SENSITIVE_SCOPE_TERMS word (paths split at
// separators, dots, dashes, underscores and camelCase). Sibling jobs whose
// own verification ran are not this gate's concern.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  MERGE_VERIFICATION_REVIEW_TYPE,
  humanInputChoicesForReviewType,
} from "../../../catalog/human-input.js";
import { BASELINE_TEST_DEBT_PAYLOAD_KEY } from "../../../catalog/verification.js";
import { parseJobPayload } from "./payload.js";

export const MERGE_REVIEW_MIN_RISK = 4;
// Gate payload key set when "fail" requeued the work item: that answer was
// spent on the rejection and no longer holds the reworked work item.
export const MERGE_VERIFICATION_REJECTION_KEY = "rejection_requeue";
export const MERGE_FAILURE_RECOVERY_KEY = "merge_failure_recovery";

const IMPLEMENTATION_JOB_TYPES = new Set(["dev", "fix"]);
const SCOPE_FIELDS = Object.freeze(["files_to_modify", "files_to_create", "files_to_delete", "create_roots"]);
export const SENSITIVE_SCOPE_TERMS = Object.freeze([
  "auth", "authn", "authz", "authenticate", "authentication", "authorization", "authorize",
  "login", "logout", "signin", "signon", "signup", "sso",
  "session", "sessions", "cookie", "cookies",
  "password", "passwords", "passwd", "credential", "credentials",
  "oauth", "jwt", "csrf", "xsrf",
  "permission", "permissions", "acl", "rbac",
  "security", "secret", "secrets", "crypto",
]);
const SENSITIVE_SCOPE_TERM_SET = new Set(SENSITIVE_SCOPE_TERMS);

export function isMergeVerificationReviewJob(job) {
  return job?.job_type === "human_input"
    && parseJobPayload(job).review_type === MERGE_VERIFICATION_REVIEW_TYPE;
}

/** The higher of the planner's risk and the execution policy's risk score. */
export function jobRiskScore(job) {
  const payload = parseJobPayload(job);
  const scores = [payload.risk, payload._execution_policy?.risk_score, payload.planner_risk_score]
    .map(Number)
    .filter(Number.isFinite);
  return scores.length > 0 ? Math.max(...scores) : 0;
}

function scopeWords(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Sensitive words in the planned scope and risk tags of the given jobs. */
export function sensitiveScopeTerms(jobs = []) {
  const terms = new Set();
  for (const job of jobs) {
    const payload = parseJobPayload(job);
    const values = [
      ...SCOPE_FIELDS.flatMap((field) => (Array.isArray(payload[field]) ? payload[field] : [])),
      ...(Array.isArray(payload.risk_tags) ? payload.risk_tags : []),
    ];
    for (const value of values) {
      for (const word of scopeWords(value)) {
        if (SENSITIVE_SCOPE_TERM_SET.has(word)) terms.add(word);
      }
    }
  }
  return [...terms].sort();
}

function plannedTestCommand(job) {
  const command = parseJobPayload(job).test_command;
  return typeof command === "string" && command.trim() ? command.trim() : null;
}

/** Jobs of the work item with a committed attempt: their changes are on the branch. */
export function committedJobIdsForWorkItem(workItemId) {
  return getDb().prepare(`
    SELECT DISTINCT a.job_id
    FROM job_attempts a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.work_item_id = ?
      AND a.commit_hash IS NOT NULL
      AND TRIM(a.commit_hash) != ''
  `).all(workItemId).map((row) => Number(row.job_id));
}

/**
 * Whether the work item's automatic merge needs operator review: a delivered
 * job's planned verification was waived or replaced because of baseline debt,
 * and such a job is high-risk or security-sensitive. Pure over `jobs` (the
 * work item's job rows) and `committedJobIds` (committedJobIdsForWorkItem);
 * without the latter only succeeded jobs count as delivered.
 */
export function mergeVerificationReviewRequirement(jobs = [], { committedJobIds = [] } = {}) {
  const implementationJobs = jobs.filter((job) => IMPLEMENTATION_JOB_TYPES.has(job?.job_type));
  const committed = new Set([...(committedJobIds || [])].map(Number));
  const delivered = (job) => (
    job.status !== "canceled"
    && !parseJobPayload(job)._superseded_by_replan
    && (job.status === "succeeded" || committed.has(Number(job.id)))
  );
  const fixesOf = new Map();
  for (const job of implementationJobs) {
    if (job.job_type !== "fix" || job.parent_job_id == null) continue;
    const parentId = Number(job.parent_job_id);
    if (!fixesOf.has(parentId)) fixesOf.set(parentId, []);
    fixesOf.get(parentId).push(job);
  }
  // The job and the fixes below it, delivered ones only, in id order.
  const deliveredLineage = (root) => {
    const lineage = [];
    const seen = new Set();
    const pending = [root];
    while (pending.length > 0) {
      const job = pending.shift();
      if (seen.has(Number(job.id))) continue;
      seen.add(Number(job.id));
      if (delivered(job)) lineage.push(job);
      pending.push(...(fixesOf.get(Number(job.id)) || []));
    }
    return lineage.sort((a, b) => Number(a.id) - Number(b.id));
  };

  const waivers = [];
  const waivedIds = new Set();
  for (const root of implementationJobs) {
    const debt = parseJobPayload(root)[BASELINE_TEST_DEBT_PAYLOAD_KEY];
    if (!debt || typeof debt !== "object" || !String(debt.command || "").trim()) continue;
    for (const job of deliveredLineage(root)) {
      if (waivedIds.has(Number(job.id))) continue;
      waivedIds.add(Number(job.id));
      waivers.push({
        job_id: Number(job.id),
        job_type: job.job_type,
        title: String(job.title || "").slice(0, 160),
        risk: jobRiskScore(job),
        command: String(debt.command).trim(),
        exit_code: debt.exit_code ?? null,
      });
    }
  }
  waivers.sort((a, b) => a.job_id - b.job_id);
  const replacements = [];
  for (const replan of jobs.filter((job) => job?.job_type === "plan")) {
    const debts = parseJobPayload(replan).baseline_test_debt;
    if (!Array.isArray(debts) || debts.length === 0) continue;
    const replacedCommands = [...new Set(debts.map((debt) => String(debt?.command || "").trim()).filter(Boolean))];
    if (replacedCommands.length === 0) continue;
    const seen = new Set();
    const replacementJobs = implementationJobs
      .filter((job) => Number(job.parent_job_id) === Number(replan.id))
      .filter((job) => !replacedCommands.includes(plannedTestCommand(job)))
      .flatMap(deliveredLineage)
      .filter((job) => !seen.has(Number(job.id)) && seen.add(Number(job.id)));
    if (replacementJobs.length === 0) continue;
    replacements.push({
      replan_job_id: Number(replan.id),
      replaced_commands: replacedCommands,
      jobs: replacementJobs.map((job) => ({
        job_id: Number(job.id),
        title: String(job.title || "").slice(0, 160),
        risk: jobRiskScore(job),
        test_command: plannedTestCommand(job),
      })),
    });
  }
  const affected = [...waivers, ...replacements.flatMap((entry) => entry.jobs)];
  if (affected.length === 0) return { required: false, waivers, replacements, triggers: [], waivedJobIds: [] };

  const affectedIds = new Set(affected.map((entry) => entry.job_id));
  const triggers = [];
  const riskiest = affected.reduce((top, entry) => (entry.risk > top.risk ? entry : top), affected[0]);
  if (riskiest.risk >= MERGE_REVIEW_MIN_RISK) {
    triggers.push({ kind: "risk", risk: riskiest.risk, job_id: riskiest.job_id });
  }
  const terms = sensitiveScopeTerms(implementationJobs.filter((job) => affectedIds.has(Number(job.id))));
  if (terms.length > 0) triggers.push({ kind: "sensitive_scope", terms });
  return {
    required: triggers.length > 0,
    waivers,
    replacements,
    triggers,
    waivedJobIds: [...affectedIds].sort((a, b) => a - b),
  };
}

function commandList(commands) {
  return commands.map((command) => `\`${command}\``).join(", ");
}

/** Operator-facing note: which verification was replaced or waived, and why review is needed. */
export function mergeVerificationReviewNote(requirement) {
  const lines = [];
  const byCommand = new Map();
  for (const waiver of requirement.waivers || []) {
    if (!byCommand.has(waiver.command)) byCommand.set(waiver.command, []);
    byCommand.get(waiver.command).push(waiver);
  }
  for (const [command, entries] of byCommand) {
    const exit = entries.find((entry) => entry.exit_code != null)?.exit_code;
    const jobs = entries.map((entry) => `#${entry.job_id} (risk ${entry.risk})`).join(", ");
    lines.push(`Planned verification \`${command}\` already failed before any change (baseline debt${exit != null ? `, exit ${exit}` : ""}), so it could not verify job ${jobs}.`);
  }
  for (const replacement of requirement.replacements || []) {
    const replacedBy = replacement.jobs
      .map((entry) => `${entry.test_command ? `\`${entry.test_command}\`` : "no test command"} (#${entry.job_id}, risk ${entry.risk})`)
      .join(", ");
    lines.push(`Replan #${replacement.replan_job_id} replaced ${commandList(replacement.replaced_commands)} with ${replacedBy}.`);
  }
  const reasons = (requirement.triggers || []).map((trigger) => (trigger.kind === "risk"
    ? `risk ${trigger.risk} on job #${trigger.job_id} (review at ${MERGE_REVIEW_MIN_RISK}+)`
    : `auth/session/security-sensitive scope (${trigger.terms.join(", ")})`));
  if (reasons.length > 0) lines.push(`No executed check covers the change, and it needs review: ${reasons.join("; ")}.`);
  return lines.join(" ");
}

/**
 * The newest review gate for the work item with its contract state, or null.
 * `approved` means answered pass and covering every job in `waivedJobIds`.
 */
export function mergeVerificationReviewGateState(workItemId, { waivedJobIds = null } = {}) {
  const row = getDb().prepare(`
    SELECT j.id, j.status, j.payload_json, hg.gate_state, hg.resolution_action
    FROM jobs j
    LEFT JOIN human_gates hg ON hg.gate_job_id = j.id
    WHERE j.work_item_id = ?
      AND j.job_type = 'human_input'
      AND CASE WHEN json_valid(j.payload_json)
        THEN json_extract(j.payload_json, '$.review_type')
        ELSE NULL END = ?
    ORDER BY j.id DESC
    LIMIT 1
  `).get(workItemId, MERGE_VERIFICATION_REVIEW_TYPE);
  if (!row) return null;
  const payload = parseJobPayload(row);
  const gateState = row.gate_state || null;
  const open = ["open", "resolving"].includes(gateState) || (gateState == null && !["succeeded", "failed", "canceled", "dead_letter"].includes(row.status));
  const passed = gateState === "resolved" && row.resolution_action === "pass";
  const requeued = !!payload[MERGE_VERIFICATION_REJECTION_KEY];
  const covered = new Set((payload.waived_job_ids || []).map(Number));
  const coversAll = !Array.isArray(waivedJobIds) || waivedJobIds.every((id) => covered.has(Number(id)));
  return {
    gate_job_id: Number(row.id),
    status: row.status,
    gate_state: gateState,
    resolution_action: row.resolution_action || null,
    open,
    requeued,
    approved: passed && coversAll,
    // Open, or answered with anything but pass that did not send the work
    // item back (a fail from before rejections requeued): the operator still
    // owns it. A fail that requeued is spent; the reworked work item gets a
    // new gate.
    holds: open || (gateState === "resolved" && row.resolution_action !== "pass" && !requeued),
  };
}

/** Cheap candidate filter: an unapproved review gate already holds this work item. */
export function mergeVerificationReviewHoldsAutoMerge(workItemId) {
  return mergeVerificationReviewGateState(workItemId)?.holds === true;
}

/** createJob() arguments for the review gate of a work item. */
export function mergeVerificationReviewGateJobSpec(workItem, requirement) {
  const note = mergeVerificationReviewNote(requirement);
  const label = `WI#${workItem.id}${workItem.title ? ` "${String(workItem.title).slice(0, 80)}"` : ""}`;
  const question = [
    `Automatic merge of ${label} stopped for review.`,
    note,
    "Answer pass to merge it after reviewing the change, or fail with feedback to send it back: its jobs rerun on the branch with your feedback, and the reworked change is reviewed again.",
  ].join(" ");
  return {
    work_item_id: workItem.id,
    job_type: "human_input",
    title: `Review merge: WI#${workItem.id} verification waived (baseline debt)`.slice(0, 160),
    priority: "high",
    max_attempts: 1,
    payload_json: JSON.stringify({
      review_type: MERGE_VERIFICATION_REVIEW_TYPE,
      choices: humanInputChoicesForReviewType(MERGE_VERIFICATION_REVIEW_TYPE),
      questions: [question],
      prompt: question,
      context: note,
      branch_name: workItem.branch_name || null,
      waived_job_ids: requirement.waivedJobIds,
      waived_verifications: requirement.waivers,
      replaced_verifications: requirement.replacements,
      review_triggers: requirement.triggers,
    }),
  };
}

/** A durable operator decision after Git rejected an automatic/manual merge. */
export function mergeFailureRecoveryGateJobSpec(workItem, {
  message = null,
  targetBranch = null,
} = {}) {
  const label = `WI#${workItem.id}${workItem.title ? ` "${String(workItem.title).slice(0, 80)}"` : ""}`;
  const detail = String(message || "Git could not merge the work-item branch").trim().slice(0, 1000);
  const question = [
    `Merge of ${label}${targetBranch ? ` into ${targetBranch}` : ""} failed: ${detail}.`,
    "Answer pass to retry the merge after resolving the repository condition, or fail with feedback to send the work item back for rework.",
  ].join(" ");
  return {
    work_item_id: workItem.id,
    job_type: "human_input",
    title: `Recover failed merge: WI#${workItem.id}`.slice(0, 160),
    priority: "high",
    max_attempts: 1,
    payload_json: JSON.stringify({
      review_type: MERGE_VERIFICATION_REVIEW_TYPE,
      choices: humanInputChoicesForReviewType(MERGE_VERIFICATION_REVIEW_TYPE),
      questions: [question],
      prompt: question,
      context: detail,
      branch_name: workItem.branch_name || null,
      waived_job_ids: [],
      [MERGE_FAILURE_RECOVERY_KEY]: {
        failed_at: new Date().toISOString(),
        target_branch: targetBranch || null,
        message: detail,
      },
    }),
  };
}
