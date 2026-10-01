// Database tasks held until their work item merges.
//
// A dev job with task_mode "db" writes the configured project database, which
// may be the live production database. When that job depends on file changes
// that exist only on its work item's branch, running it before the merge
// writes data that only the unmerged code understands. Such a job is parked
// (waiting_on_human, with a hold record in its payload) instead of running,
// and it does not hold up the work item's completion or merge. Merge
// settlement then opens an operator gate, because Posse cannot know when the
// merged change is deployed: "run" requeues the same job, which then reads the
// merged target checkout, and "skip" cancels it.
//
// "Depends on unmerged file changes" means: a hard dependency, direct or
// through other same-work-item jobs, on a same-work-item job with a committed
// attempt, while the work item has a branch that is not merged yet.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  POST_MERGE_DB_TASK_REVIEW_TYPE,
  humanInputChoicesForReviewType,
} from "../../../catalog/human-input.js";
import {
  DB_TASK_PRE_MERGE_POLICIES,
  DB_TASK_PRE_MERGE_POLICY_VALUES,
} from "../../../catalog/settings.js";
import { TERMINAL_JOB_STATUSES_SQL } from "../../../catalog/job.js";
import { parseJobPayload } from "./payload.js";

export const POST_MERGE_DB_HOLD_KEY = "_post_merge_db_hold";

export function isDbTaskJob(job) {
  return job?.job_type === "dev" && (parseJobPayload(job).task_mode || "code") === "db";
}

export function postMergeDbHoldRecord(job) {
  const record = parseJobPayload(job)[POST_MERGE_DB_HOLD_KEY];
  return record && typeof record === "object" && !Array.isArray(record) ? record : null;
}

/** Parked behind its work item's merge (or the post-merge gate) and not yet released. */
export function isPostMergeHeldDbJob(job) {
  if (job?.status !== "waiting_on_human" || !isDbTaskJob(job)) return false;
  const record = postMergeDbHoldRecord(job);
  return !!record && !record.released_at;
}

export function isPostMergeDbGateJob(job) {
  return job?.job_type === "human_input"
    && parseJobPayload(job).review_type === POST_MERGE_DB_TASK_REVIEW_TYPE;
}

/**
 * A held or operator-released database task, or its gate. Merge settlement
 * must not treat these as stale work: they are the post-merge step itself.
 */
export function isPostMergeDbTaskJob(job) {
  if (isPostMergeDbGateJob(job)) return true;
  return isDbTaskJob(job) && postMergeDbHoldRecord(job) != null;
}

export function normalizeDbTaskPreMergePolicy(value) {
  const policy = String(value ?? "").trim().toLowerCase();
  return DB_TASK_PRE_MERGE_POLICY_VALUES.includes(policy) ? policy : DB_TASK_PRE_MERGE_POLICIES.HOLD;
}

/** Same-work-item upstream jobs (hard edges, transitively) that committed file changes. */
export function committedSameWorkItemDependencyIds(job) {
  if (!job?.id || job.work_item_id == null) return [];
  return getDb().prepare(`
    WITH RECURSIVE upstream(id) AS (
      SELECT jd.depends_on_job_id
      FROM job_dependencies jd
      JOIN jobs dep ON dep.id = jd.depends_on_job_id
      WHERE jd.job_id = ? AND jd.dependency_kind = 'hard' AND dep.work_item_id = ?
      UNION
      SELECT jd.depends_on_job_id
      FROM job_dependencies jd
      JOIN upstream u ON jd.job_id = u.id
      JOIN jobs dep ON dep.id = jd.depends_on_job_id
      WHERE jd.dependency_kind = 'hard' AND dep.work_item_id = ?
    )
    SELECT u.id
    FROM upstream u
    WHERE EXISTS (
      SELECT 1 FROM job_attempts a
      WHERE a.job_id = u.id
        AND a.commit_hash IS NOT NULL
        AND TRIM(a.commit_hash) != ''
    )
    ORDER BY u.id
  `).all(job.id, job.work_item_id, job.work_item_id).map((row) => Number(row.id));
}

/**
 * Decide whether a database task must wait for its work item's merge.
 * Returns { hold, reason, dependencyJobIds?, workItem? }.
 */
export function postMergeDbHoldDecision(job, { policy = DB_TASK_PRE_MERGE_POLICIES.HOLD } = {}) {
  if (!isDbTaskJob(job)) return { hold: false, reason: "not_db_task" };
  if (postMergeDbHoldRecord(job)?.released_at) return { hold: false, reason: "released_after_merge" };
  const workItem = getDb().prepare(`
    SELECT id, title, branch_name, merge_state FROM work_items WHERE id = ?
  `).get(job.work_item_id);
  if (!workItem?.branch_name) return { hold: false, reason: "no_work_item_branch" };
  if (workItem.merge_state === "merged") return { hold: false, reason: "work_item_merged" };
  const dependencyJobIds = committedSameWorkItemDependencyIds(job);
  if (dependencyJobIds.length === 0) return { hold: false, reason: "no_unmerged_file_dependency" };
  if (normalizeDbTaskPreMergePolicy(policy) === DB_TASK_PRE_MERGE_POLICIES.RUN) {
    return { hold: false, reason: "pre_merge_policy_run", dependencyJobIds };
  }
  return { hold: true, reason: "unmerged_file_dependency", dependencyJobIds, workItem };
}

const DEPENDENT_SCOPE_FIELDS = Object.freeze(["files_to_modify", "files_to_create", "files_to_delete", "create_roots"]);
const DEPENDENT_SCOPE_MAX_PATHS = 20;

/**
 * What the operator needs to re-queue a dependent canceled because its
 * database task was held: identity, job type, and the planned scope and test
 * command from its payload when present.
 */
export function canceledDependentSummary(job) {
  const payload = parseJobPayload(job);
  const summary = {
    job_id: Number(job.id),
    title: String(job.title || "").slice(0, 200),
    job_type: job.job_type,
  };
  if (payload.task_mode) summary.task_mode = String(payload.task_mode);
  for (const field of DEPENDENT_SCOPE_FIELDS) {
    const paths = Array.isArray(payload[field])
      ? payload[field].map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
    if (paths.length > 0) summary[field] = paths.slice(0, DEPENDENT_SCOPE_MAX_PATHS);
  }
  if (typeof payload.test_command === "string" && payload.test_command.trim()) {
    summary.test_command = payload.test_command.trim().slice(0, 300);
  }
  return summary;
}

export function heldPostMergeDbPayload(job, {
  dependencyJobIds = [],
  canceledDependents = [],
  heldAt = new Date().toISOString(),
} = {}) {
  // A re-applied hold (the first park lost its lease) keeps the dependents
  // the earlier pass already canceled.
  const previous = Array.isArray(postMergeDbHoldRecord(job)?.canceled_dependents)
    ? postMergeDbHoldRecord(job).canceled_dependents
    : [];
  const byId = new Map(previous.map((entry) => [Number(entry.job_id), entry]));
  for (const entry of canceledDependents) byId.set(Number(entry.job_id), entry);
  return {
    ...parseJobPayload(job),
    [POST_MERGE_DB_HOLD_KEY]: {
      reason: "unmerged_file_dependency",
      dependency_job_ids: dependencyJobIds.map(Number),
      canceled_dependents: [...byId.values()],
      held_at: heldAt,
    },
  };
}

function formatCanceledDependent(entry) {
  const paths = DEPENDENT_SCOPE_FIELDS.flatMap((field) => (Array.isArray(entry[field]) ? entry[field] : []));
  const details = [entry.job_type, entry.task_mode && entry.task_mode !== "code" ? entry.task_mode : null]
    .filter(Boolean).join("/");
  const scope = paths.length > 0
    ? `; scope: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` +${paths.length - 3} more` : ""}`
    : "";
  const test = entry.test_command ? `; test: ${entry.test_command}` : "";
  return `#${entry.job_id} "${String(entry.title || "").slice(0, 80)}" (${details}${scope}${test})`;
}

/** Operator-facing line naming the dependents the hold canceled, or saying there were none. */
export function canceledDependentsNotice(record) {
  const entries = Array.isArray(record?.canceled_dependents) ? record.canceled_dependents : [];
  if (entries.length === 0) return "No dependent jobs were canceled while it was held.";
  const shown = entries.slice(0, 8).map(formatCanceledDependent);
  const more = entries.length > shown.length ? `, +${entries.length - shown.length} more` : "";
  return `Canceled while held (re-queue after running): ${shown.join(", ")}${more}.`;
}

export function releasedPostMergeDbPayload(job, { gateJobId = null, releasedAt = new Date().toISOString() } = {}) {
  return {
    ...parseJobPayload(job),
    [POST_MERGE_DB_HOLD_KEY]: {
      ...(postMergeDbHoldRecord(job) || {}),
      released_at: releasedAt,
      released_by_gate_job_id: gateJobId == null ? null : Number(gateJobId),
    },
  };
}

export function hasActivePostMergeDbGate(heldJobId) {
  return !!getDb().prepare(`
    SELECT 1
    FROM jobs j
    LEFT JOIN human_gates hg ON hg.gate_job_id = j.id
    WHERE j.job_type = 'human_input'
      AND j.parent_job_id = ?
      AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
      AND (hg.gate_job_id IS NULL OR hg.gate_state IN ('open','resolving'))
      AND CASE WHEN json_valid(j.payload_json)
        THEN json_extract(j.payload_json, '$.review_type')
        ELSE NULL END = ?
    LIMIT 1
  `).get(heldJobId, POST_MERGE_DB_TASK_REVIEW_TYPE);
}

/** createJob() arguments for the post-merge operator gate of a held task. */
export function postMergeDbGateJobSpec(heldJob, workItem = null) {
  const record = postMergeDbHoldRecord(heldJob) || {};
  const taskTitle = String(heldJob.title || "").slice(0, 120);
  const workItemLabel = `WI#${heldJob.work_item_id}${workItem?.title ? ` "${String(workItem.title).slice(0, 80)}"` : ""}`;
  const canceledDependents = Array.isArray(record.canceled_dependents) ? record.canceled_dependents : [];
  const dependentsNotice = canceledDependentsNotice(record);
  const question = [
    `Post-merge database task ready: ${workItemLabel} is merged.`,
    `Run database task #${heldJob.id} "${taskTitle}" against the project database now?`,
    "Answer run once the merged change is deployed, or skip to drop the task.",
    dependentsNotice,
  ].join(" ");
  return {
    work_item_id: heldJob.work_item_id,
    job_type: "human_input",
    title: `Post-merge database task ready: ${taskTitle}`.slice(0, 160),
    parent_job_id: heldJob.id,
    payload_json: JSON.stringify({
      review_type: POST_MERGE_DB_TASK_REVIEW_TYPE,
      original_job_id: heldJob.id,
      choices: humanInputChoicesForReviewType(POST_MERGE_DB_TASK_REVIEW_TYPE),
      questions: [question],
      prompt: question,
      context: dependentsNotice,
      dependency_job_ids: Array.isArray(record.dependency_job_ids) ? record.dependency_job_ids : [],
      canceled_dependents: canceledDependents,
    }),
  };
}
