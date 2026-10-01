// Work-item disposition gates.
//
// Two waiting states used to have no gate the operator could answer
// (wowiekowie 2026-10-01 18:35: zero open gates while WIs 164, 167 and 170
// waited on the operator):
//
// - A failed work item that still owns a branch or implementation work. Its
//   gate offers retry (requeue the failed jobs on the same branch, keeping its
//   commits), accept (operator-pass jobs that failed only at assessment, so
//   the work item completes into review and merge) and abandon (cancel it and
//   delete its branch).
// - A completed work item whose cross-WI merge dependency points at a failed
//   or canceled upstream, so its merge defers forever. Its gate offers wait
//   (keep deferring; resolved automatically once the upstream merges; not
//   offered once an upstream was canceled), rebuild (drop the branch with
//   its inherited handoff commits and replan from the target branch) and
//   abandon.
//
// Both gates belong to the work item, not to a job (no original job). They
// are parked like push offers and post-merge database gates: they never count
// toward work-item status, completion, run closeout or the headless human
// timeout, so a headless run still ends with the item failed or complete and
// the gate waits for the phone, the TUI resurface, or `posse gate answer`.
//
// This module only reads; queue-store owns the transitions that open, settle
// and act on these gates.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
  WORK_ITEM_DISPOSITION_REVIEW_TYPES,
  WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
  humanInputChoicesForReviewType,
} from "../../../catalog/human-input.js";
import {
  FAILED_JOB_STATUSES,
  MUTATING_JOB_TYPES,
  NON_COMPLETION_BLOCKING_JOB_TYPES,
  QUEUE_LOCKING_JOB_TYPES,
  TERMINAL_JOB_STATUSES_SQL,
} from "../../../catalog/job.js";
import { getWorkItemMergeDependencies } from "./cross-wi-deps.js";
import { parseJobPayload } from "./payload.js";
import {
  POST_MERGE_DB_SUPERSEDED_KEY,
  dbTaskBypassUpstreamIds,
  isDbTaskJob,
  postMergeDbHoldRecord,
} from "./post-merge-db-tasks.js";

const DISPOSITION_REVIEW_TYPE_SET = new Set(WORK_ITEM_DISPOSITION_REVIEW_TYPES);
const FAILED_JOB_STATUS_SET = new Set(FAILED_JOB_STATUSES);
// The implementation finished and committed; only its assessment failed (or
// could not complete). An operator pass of such a job is a review decision,
// not a claim that unexecuted work succeeded.
const ASSESSMENT_ONLY_FAILURE_STATES = new Set([
  "assessment_failed",
  "assessment_needs_human",
  "assessment_unavailable",
]);
const MAX_LISTED_JOBS = 8;
// Failures older than this get a gate only from the failing transition
// itself, not from gate maintenance, so upgrading a long-lived queue does not
// flood the phone with recovery questions for long-abandoned work.
export const WORK_ITEM_DISPOSITION_BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function isWorkItemDispositionPayload(payload = {}) {
  return DISPOSITION_REVIEW_TYPE_SET.has(String(payload?.review_type || ""));
}

export function isWorkItemDispositionGateJob(job) {
  return job?.job_type === "human_input" && isWorkItemDispositionPayload(parseJobPayload(job));
}

export function isWorkItemFailureDispositionGateJob(job) {
  return job?.job_type === "human_input"
    && parseJobPayload(job).review_type === WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE;
}

export function isCrossWiUpstreamDispositionGateJob(job) {
  return job?.job_type === "human_input"
    && parseJobPayload(job).review_type === CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE;
}

/** A failed work item is worth a recovery gate while it owns a branch or implementation work. */
export function workItemFailureIsRecoverable(workItem, jobs = []) {
  if (!workItem || workItem.status !== "failed") return false;
  if (String(workItem.branch_name || "").trim()) return true;
  return jobs.some((job) => QUEUE_LOCKING_JOB_TYPES.has(job?.job_type));
}

/** The job a gate decides about (payload original_job_id), or null for a standalone question. */
export function gateOriginalJobId(job) {
  if (job?.job_type !== "human_input") return null;
  const id = Number(parseJobPayload(job).original_job_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The failed jobs a recovery acts on: failed completion blockers that are not
 * the parent of another failed blocker. A failed fix of a failed dev job is
 * retried or accepted in place of its parent, which it then recovers.
 *
 * A failed gate is a decision about its original job, not work of its own.
 * A headless timeout fails both the gate and the job it was deciding
 * (headless-recovery.js), and the job is what failed: the gate is never a
 * leaf and never hides its original. Retry and accept retire it instead
 * (supersededFailedGateJobs). A failed question with no original job stays a
 * leaf: retrying it asks again.
 */
export function failedLeafJobs(blockers = []) {
  const failed = blockers.filter((job) => (
    FAILED_JOB_STATUS_SET.has(job?.status) && gateOriginalJobId(job) == null
  ));
  const failedParentIds = new Set(failed
    .filter((job) => job.job_type !== "human_input")
    .map((job) => Number(job.parent_job_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0));
  return failed.filter((job) => !failedParentIds.has(Number(job.id)));
}

/**
 * Failed gates that block completion only because they timed out with the
 * job they decided. Their question died with them: retry and accept retire
 * them, or the recovered work item would fail again on the dead gate.
 */
export function supersededFailedGateJobs(blockers = []) {
  return blockers.filter((job) => FAILED_JOB_STATUS_SET.has(job?.status) && gateOriginalJobId(job) != null);
}

const ASSESSMENT_VERDICT_ERROR_PREFIX = "Assessment verdict ";

/**
 * Whether the job's latest attempt got through implementation, so a failure
 * recorded since is the assessment's. assessment_state is not reset when a
 * new implementation attempt starts (attempts.js), so a job that failed
 * assessment and then failed in execution still reads assessment_failed; the
 * attempt rows tell them apart:
 * - an assessment attempt after the last implementation attempt (assess-only
 *   retry) means the implementation had finished;
 * - an implementation attempt that succeeded finished it (assessment
 *   infrastructure failures complete it as succeeded before routing);
 * - a failed implementation attempt failed at assessment only when the
 *   attached assessment failed it: its error is the verdict, or it committed
 *   and the verdict routed to a gate without an error text.
 * Anything else (blocked, interrupted, still running, an execution error) is
 * an execution failure.
 */
export function latestAttemptFailedAtAssessment(jobId) {
  const latest = getDb().prepare(`
    SELECT attempt_kind, status, commit_hash, error_text
    FROM job_attempts
    WHERE job_id = ? AND attempt_kind IN ('implementation', 'assessment')
    ORDER BY attempt_number DESC, id DESC
    LIMIT 1
  `).get(jobId);
  if (!latest) return false;
  if (latest.attempt_kind === "assessment") return true;
  if (latest.status === "succeeded") return true;
  if (latest.status !== "failed") return false;
  const error = String(latest.error_text || "").trim();
  if (error.startsWith(ASSESSMENT_VERDICT_ERROR_PREFIX)) return true;
  return !error && !!String(latest.commit_hash || "").trim();
}

export function isAssessmentOnlyFailedJob(job) {
  if (job?.status !== "failed" || !MUTATING_JOB_TYPES.has(job.job_type)) return false;
  if (!ASSESSMENT_ONLY_FAILURE_STATES.has(job.assessment_state)) return false;
  return latestAttemptFailedAtAssessment(job.id);
}

/**
 * Database tasks of a work item whose merge hold is still open: held for its
 * merge, or canceled while held and never released. A task canceled with the
 * work item's failure (canceled_with_work_item) is held again by a recovery
 * (reholdPostMergeDbTasksForWorkItem). One canceled by anything else, such as
 * an operator's `posse cancel` (live WI 164's 2134, canceled from the CLI
 * after the failure with no marker), stays canceled: recovery respects that
 * cancel, but its hold record still lists the code dependents the hold
 * canceled, and recovery brings those back (failedWorkItemRestorationPlan).
 *
 * A task superseded by a rebuild or replan, or canceled as the duplicate of a
 * newer plan's task, belongs to a discarded plan and is none of these.
 */
export function recoverableHeldDbTasks(jobs = []) {
  return jobs.filter((job) => {
    if (!isDbTaskJob(job)) return false;
    const record = postMergeDbHoldRecord(job);
    if (!record || record.released_at || record.superseded_by_rebuild) return false;
    const payload = parseJobPayload(job);
    if (payload._superseded_by_replan || payload[POST_MERGE_DB_SUPERSEDED_KEY]) return false;
    return job.status === "waiting_on_human" || job.status === "canceled";
  });
}

/** Held database tasks a recovery leaves canceled: canceled by something other than the work item's failure. */
export function operatorCanceledHeldDbTasks(jobs = []) {
  return recoverableHeldDbTasks(jobs)
    .filter((job) => job.status === "canceled" && !postMergeDbHoldRecord(job).canceled_with_work_item);
}

/**
 * What a retry or accept of a failed work item brings back besides the jobs
 * it reruns (`rerunJobIds`: the requeued or accepted leaves):
 *
 * - Dependents a database task's merge hold canceled (its hold record lists
 *   them). They need the committed migration, not the applied database, so
 *   they are rewired onto the task's own upstream (the job that wrote the
 *   migration file), as the hold does for live dependents
 *   (rewireDependentAroundDbTask), and run again once that upstream ran.
 *   WI 164's 2135 was canceled behind held task 2134 and never came back.
 *   That holds however the task itself was canceled (recoverableHeldDbTasks):
 *   live, 2134 was canceled by the operator, not with the failure.
 * - Canceled jobs that only stopped because a job about to run again failed
 *   or was held: every hard dependency runs again, is restored here, or
 *   already succeeded (WI 164's 2137, behind 2135 and 2136).
 *
 * A dependency on a retired gate counts as one on the job that gate decided
 * (a dead-lettered job's dependents wait on its blocked gate), and a job the
 * gate's timeout canceled comes back like one the hold canceled. Anything
 * else keeps a dependency that will not run and stays canceled.
 *
 * Returns { restored, rewires }: rewires lists { job, from_job_id,
 * to_job_ids, db_task } (db_task null for a retired gate) to apply before
 * the restored jobs are requeued.
 */
export function failedWorkItemRestorationPlan(workItemId, rerunJobIds = [], {
  supersededGates = [],
  restoreHeldDependents = true,
} = {}) {
  const db = getDb();
  const jobs = db.prepare(`SELECT * FROM jobs WHERE work_item_id = ? ORDER BY id`).all(workItemId);
  const byId = new Map(jobs.map((job) => [Number(job.id), job]));
  const readStatus = db.prepare(`SELECT status FROM jobs WHERE id = ?`);
  const statusOf = (jobId) => byId.get(jobId)?.status ?? readStatus.get(jobId)?.status ?? null;
  const hardDeps = new Map();
  for (const row of db.prepare(`
    SELECT jd.job_id, jd.depends_on_job_id
    FROM job_dependencies jd
    JOIN jobs j ON j.id = jd.job_id
    WHERE j.work_item_id = ? AND jd.dependency_kind = 'hard'
  `).all(workItemId)) {
    const jobId = Number(row.job_id);
    if (!hardDeps.has(jobId)) hardDeps.set(jobId, []);
    hardDeps.get(jobId).push(Number(row.depends_on_job_id));
  }

  const gateOriginal = new Map();
  for (const gate of supersededGates) {
    const originalId = gateOriginalJobId(gate);
    if (originalId != null) gateOriginal.set(Number(gate.id), originalId);
  }
  const heldTasks = new Map();
  const heldSeeds = new Map();
  if (restoreHeldDependents) {
    for (const task of recoverableHeldDbTasks(jobs)) {
      const upstreamIds = dbTaskBypassUpstreamIds(task);
      if (upstreamIds.length === 0) continue;
      heldTasks.set(Number(task.id), { task, upstreamIds });
      const entries = postMergeDbHoldRecord(task).canceled_dependents;
      for (const entry of Array.isArray(entries) ? entries : []) {
        const dependentId = Number(entry?.job_id);
        if (byId.get(dependentId)?.status !== "canceled") continue;
        if (!heldSeeds.has(dependentId)) heldSeeds.set(dependentId, []);
        heldSeeds.get(dependentId).push(Number(task.id));
      }
    }
  }

  const rewiresFor = (jobId) => {
    const rewires = [];
    for (const depId of hardDeps.get(jobId) || []) {
      if (gateOriginal.has(depId)) {
        rewires.push({ from_job_id: depId, to_job_ids: [gateOriginal.get(depId)], db_task: null });
      } else if ((heldSeeds.get(jobId) || []).includes(depId)) {
        const { task, upstreamIds } = heldTasks.get(depId);
        rewires.push({ from_job_id: depId, to_job_ids: upstreamIds.filter((id) => id !== jobId), db_task: task });
      }
    }
    return rewires;
  };
  const effectiveDeps = (jobId, rewires) => {
    const replaced = new Map(rewires.map((rewire) => [rewire.from_job_id, rewire.to_job_ids]));
    return [...new Set((hardDeps.get(jobId) || []).flatMap((depId) => replaced.get(depId) || [depId]))];
  };

  const willRun = new Set([...rerunJobIds].map(Number));
  const restored = [];
  const rewires = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of jobs) {
      const jobId = Number(job.id);
      if (job.status !== "canceled" || willRun.has(jobId)) continue;
      if (job.job_type === "human_input" || NON_COMPLETION_BLOCKING_JOB_TYPES.has(job.job_type)) continue;
      if (isDbTaskJob(job) && postMergeDbHoldRecord(job)) continue;
      // A discarded plan's job: its branch went away with a rebuild or replan.
      if (parseJobPayload(job)._superseded_by_replan) continue;
      const jobRewires = rewiresFor(jobId);
      const deps = effectiveDeps(jobId, jobRewires);
      const seed = heldSeeds.has(jobId) || jobRewires.some((rewire) => !rewire.db_task);
      if (!seed && !deps.some((depId) => willRun.has(depId))) continue;
      if (!deps.every((depId) => willRun.has(depId) || statusOf(depId) === "succeeded")) continue;
      willRun.add(jobId);
      restored.push(job);
      for (const rewire of jobRewires) rewires.push({ job, ...rewire });
      changed = true;
    }
  }
  return { restored, rewires };
}

const MAX_PREVIOUS_PLAN_TASKS = 12;

function describePlanTask(job) {
  const payload = parseJobPayload(job);
  const mode = payload.task_mode && payload.task_mode !== "code" ? `/${payload.task_mode}` : "";
  return `- #${job.id} ${job.job_type}${mode} (${job.status}): ${String(job.title || "").slice(0, 160)}`;
}

/**
 * Planner context for a replan of a work item whose branch was discarded (a
 * rebuild, or a review rejection that deleted the branch): what the discarded
 * plan contained (its fix jobs patched code that went with the branch, so
 * they are left out; so is a plan an earlier replan already discarded), and
 * every database task that already changed the project database.
 *
 * `appliedDbTasks` ({ job_id, title, job_type? }) are the database tasks that
 * ran, from the job rows and the work item's durable record (an earlier
 * replan cancels the succeeded tasks of the plan it discards, so the rows
 * alone forget them on the next rebuild). `heldDbTaskIds` are database tasks
 * that were held for the discarded branch's merge, canceled or not.
 */
export function discardedPlanContext(jobs = [], { heldDbTaskIds = [], appliedDbTasks = [] } = {}) {
  const heldIds = new Set(heldDbTaskIds.map(Number));
  const tasks = jobs.filter((job) => (
    MUTATING_JOB_TYPES.has(job.job_type)
    && job.job_type !== "fix"
    && (job.status !== "canceled" || heldIds.has(Number(job.id)))
    && !parseJobPayload(job)._superseded_by_replan
  ));
  const lines = [];
  if (tasks.length > 0) {
    lines.push(
      "PREVIOUS PLAN (discarded with the branch; reference for scope only, every task runs again on the current target branch):",
      ...tasks.slice(0, MAX_PREVIOUS_PLAN_TASKS).map(describePlanTask),
    );
    if (tasks.length > MAX_PREVIOUS_PLAN_TASKS) lines.push(`- +${tasks.length - MAX_PREVIOUS_PLAN_TASKS} more`);
  }
  if (appliedDbTasks.length > 0) {
    lines.push(
      "DATABASE TASKS THAT ALREADY RAN against the project database (their changes are applied; do not apply them again):",
      ...appliedDbTasks.map((entry) => `- #${entry.job_id} ${entry.job_type || "dev"}/db (ran): ${String(entry.title || "").slice(0, 160)}`),
    );
  }
  return lines.join("\n");
}

function describeFailedJob(job) {
  const where = isAssessmentOnlyFailedJob(job)
    ? `failed at assessment: ${job.assessor_verdict || job.assessment_state}`
    : `${job.status} during execution`;
  return `#${job.id} "${String(job.title || "").slice(0, 80)}" (${job.job_type}, ${where})`;
}

function listed(entries, formatter) {
  const shown = entries.slice(0, MAX_LISTED_JOBS).map(formatter);
  const more = entries.length > shown.length ? `, +${entries.length - shown.length} more` : "";
  return `${shown.join(", ")}${more}`;
}

/**
 * Which failed leaf jobs an "accept" answer would pass, and what blocks it.
 * Accept is all-or-nothing: a job that failed during execution has no
 * committed result to accept, and accepting only some jobs would just fail
 * the work item again.
 */
export function failedWorkItemAcceptance(leaves = []) {
  const acceptable = leaves.filter(isAssessmentOnlyFailedJob);
  const notAcceptable = leaves.filter((job) => !isAssessmentOnlyFailedJob(job));
  if (leaves.length === 0) {
    return { ok: false, reason: "no_failed_jobs", acceptable, notAcceptable };
  }
  if (notAcceptable.length > 0) {
    return { ok: false, reason: "execution_failures", acceptable, notAcceptable };
  }
  return { ok: true, reason: null, acceptable, notAcceptable };
}

export function acceptanceRefusalMessage(workItemId, acceptance) {
  if (acceptance.reason === "no_failed_jobs") {
    return `Cannot accept WI#${workItemId}: no failed job remains to accept. Answer retry or abandon.`;
  }
  return `Cannot accept WI#${workItemId}: ${listed(acceptance.notAcceptable, describeFailedJob)} did not fail at assessment, so there is no committed result to accept. Answer retry or abandon.`;
}

/** Non-terminal disposition gates of one kind on a work item. */
export function activeWorkItemDispositionGates(workItemId, reviewType) {
  return getDb().prepare(`
    SELECT j.*
    FROM jobs j
    LEFT JOIN human_gates hg ON hg.gate_job_id = j.id
    WHERE j.work_item_id = ?
      AND j.job_type = 'human_input'
      AND j.status NOT IN (${TERMINAL_JOB_STATUSES_SQL})
      AND (hg.gate_job_id IS NULL OR hg.gate_state IN ('open','resolving'))
      AND CASE WHEN json_valid(j.payload_json)
        THEN json_extract(j.payload_json, '$.review_type')
        ELSE NULL END = ?
    ORDER BY j.id
  `).all(workItemId, reviewType);
}

/** Every disposition gate of one kind a work item ever had, newest first. */
export function workItemDispositionGateHistory(workItemId, reviewType) {
  return getDb().prepare(`
    SELECT j.*
    FROM jobs j
    WHERE j.work_item_id = ?
      AND j.job_type = 'human_input'
      AND CASE WHEN json_valid(j.payload_json)
        THEN json_extract(j.payload_json, '$.review_type')
        ELSE NULL END = ?
    ORDER BY j.id DESC
  `).all(workItemId, reviewType);
}

/**
 * One failure of a work item. A gate is opened at most once per episode: an
 * answered or retired gate is not reopened until the work item fails again.
 */
export function workItemFailureEpisode(workItem) {
  return String(workItem?.completed_at || workItem?.updated_at || "");
}

export function hasWorkItemFailureGateForEpisode(workItem) {
  const episode = workItemFailureEpisode(workItem);
  return workItemDispositionGateHistory(workItem.id, WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE)
    .some((gate) => parseJobPayload(gate).failure_episode === episode);
}

/**
 * Upstream work items a completed work item's merge is waiting for although
 * they failed or were canceled, so they will not merge unless recovered.
 */
export function staleCrossWiUpstreams(workItem) {
  if (!workItem) return [];
  const db = getDb();
  const readSource = db.prepare(`SELECT id, title, status, merge_state, branch_name, completed_at FROM work_items WHERE id = ?`);
  const bySource = new Map();
  for (const dep of getWorkItemMergeDependencies(workItem)) {
    const sourceId = Number(dep.source_work_item_id);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || sourceId === Number(workItem.id)) continue;
    if (!bySource.has(sourceId)) {
      const source = readSource.get(sourceId);
      if (!source || source.merge_state === "merged" || !["failed", "canceled"].includes(source.status)) continue;
      bySource.set(sourceId, {
        source_work_item_id: sourceId,
        title: String(source.title || "").slice(0, 120),
        status: source.status,
        completed_at: source.completed_at || null,
        source_branch: dep.source_branch || source.branch_name || null,
        paths: [],
      });
    }
    const entry = bySource.get(sourceId);
    if (entry && dep.path && !entry.paths.includes(dep.path)) entry.paths.push(dep.path);
  }
  return [...bySource.values()];
}

export function crossWiUpstreamEpisode(upstream) {
  return `${upstream.source_work_item_id}:${upstream.status}:${upstream.completed_at || ""}`;
}

/** The upstream episodes a cross-WI upstream gate asks about. */
export function crossWiUpstreamGateEpisodes(gate) {
  const episodes = parseJobPayload(gate).upstream_episodes;
  return Array.isArray(episodes) ? episodes.map(String) : [];
}

/**
 * Stale upstreams no earlier gate on this work item has asked about yet. Only
 * an open gate or an answered one has asked: a gate retired unanswered
 * (canceled when the work item left complete, e.g. holdWorkItemForPendingMerge)
 * or whose answer no longer applied (failed) leaves the question open, so a
 * work item that is stranded again gets a live gate again.
 */
export function unaskedStaleCrossWiUpstreams(workItem, upstreams = staleCrossWiUpstreams(workItem)) {
  const asked = new Set();
  for (const gate of workItemDispositionGateHistory(workItem.id, CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE)) {
    if (gate.status === "canceled" || gate.status === "failed") continue;
    for (const episode of crossWiUpstreamGateEpisodes(gate)) asked.add(episode);
  }
  return upstreams.filter((upstream) => !asked.has(crossWiUpstreamEpisode(upstream)));
}

/**
 * "wait" means waiting for the upstreams to be recovered and merged. A
 * canceled work item is terminal and never merges, and the merge needs every
 * upstream merged, so with any upstream canceled the gate offers only
 * rebuild and abandon.
 */
export function crossWiUpstreamWaitAvailable(upstreams = []) {
  return !upstreams.some((upstream) => upstream.status === "canceled");
}

/** "WI#1, WI#2 was/were canceled and will never merge" for the canceled upstreams, or null. */
export function canceledCrossWiUpstreamsText(upstreams = []) {
  const canceled = upstreams.filter((upstream) => upstream.status === "canceled");
  if (canceled.length === 0) return null;
  const ids = canceled.map((upstream) => `WI#${upstream.source_work_item_id}`).join(", ");
  return `${ids} ${canceled.length === 1 ? "was" : "were"} canceled and will never merge`;
}

function workItemLabel(workItem) {
  return `WI#${workItem.id}${workItem.title ? ` "${String(workItem.title).slice(0, 80)}"` : ""}`;
}

function describeRestoredJob(job) {
  return `#${job.id} "${String(job.title || "").slice(0, 80)}"`;
}

/**
 * Operator-facing lines for what retry and accept bring back besides the
 * failed jobs; empty when nothing (failedWorkItemRestorationPlan).
 */
export function restorationNotice({ restored = [], rewires = [] } = {}) {
  if (restored.length === 0) return [];
  const lines = [`retry or accept also requeues the canceled dependent${restored.length === 1 ? "" : "s"} ${listed(restored, describeRestoredJob)}.`];
  const held = rewires.filter((rewire) => rewire.db_task);
  if (held.length > 0) {
    const byTask = new Map();
    for (const rewire of held) {
      const taskId = Number(rewire.db_task.id);
      if (!byTask.has(taskId)) byTask.set(taskId, { jobs: [], upstream: new Set() });
      byTask.get(taskId).jobs.push(`#${rewire.job.id}`);
      for (const id of rewire.to_job_ids) byTask.get(taskId).upstream.add(`#${id}`);
    }
    for (const [taskId, entry] of byTask) {
      lines.push(`${entry.jobs.join(", ")} ${entry.jobs.length === 1 ? "was" : "were"} canceled when database task #${taskId} was held for the merge; ${entry.jobs.length === 1 ? "it now runs" : "they now run"} after ${[...entry.upstream].join(", ")} (the committed migration) instead of the applied database.`);
    }
  }
  return lines;
}

/** createJob() arguments for a failed work item's recovery gate. */
export function workItemFailureDispositionGateSpec(workItem, {
  leaves = [],
  supersededGates = [],
  canceledHeldDbTasks = [],
  operatorCanceledDbTasks = [],
  restoration = { restored: [], rewires: [] },
} = {}) {
  const acceptance = failedWorkItemAcceptance(leaves);
  const branch = String(workItem.branch_name || "").trim();
  const timedOutGates = supersededGates.map((gate) => `#${gate.id}`);
  const failedLine = leaves.length > 0
    ? `Failed: ${listed(leaves, describeFailedJob)}.`
    : timedOutGates.length > 0
      ? `No failed job remains; only the timed-out gate${timedOutGates.length === 1 ? "" : "s"} ${timedOutGates.join(", ")} ${timedOutGates.length === 1 ? "blocks" : "block"} completion.`
      : "No failed job remains; the work item failed its completion contract.";
  const retryLine = leaves.length > 0
    ? `retry: requeue ${leaves.length === 1 ? "that job" : "those jobs"}${branch ? " on the existing branch (its commits are kept)" : ""}.`
    : timedOutGates.length > 0
      ? `retry: retire ${timedOutGates.length === 1 ? "that gate" : "those gates"} and complete the work item.`
      : "retry: replan the work item.";
  const acceptLine = acceptance.ok
    ? `accept: pass ${listed(acceptance.acceptable, (job) => `#${job.id}`)} as an operator review (the failure was assessment-only) and send the work item to review and merge.`
    : `accept: unavailable, ${acceptance.reason === "no_failed_jobs"
      ? "no failed job remains to accept"
      : `${listed(acceptance.notAcceptable, (job) => `#${job.id}`)} did not fail at assessment`}.`;
  const abandonLine = `abandon: cancel the work item${branch ? " and delete its branch" : ""}.`;
  const gatesLine = leaves.length > 0 && timedOutGates.length > 0
    ? `Gate${timedOutGates.length === 1 ? "" : "s"} ${timedOutGates.join(", ")} timed out with the failed job${timedOutGates.length === 1 ? "" : "s"}; retry or accept retires ${timedOutGates.length === 1 ? "it" : "them"}.`
    : null;
  const restoredLines = restorationNotice(restoration);
  const heldLine = canceledHeldDbTasks.length > 0
    ? `Database task${canceledHeldDbTasks.length === 1 ? "" : "s"} ${canceledHeldDbTasks.map((job) => `#${job.id}`).join(", ")} held for the merge ${canceledHeldDbTasks.length === 1 ? "was" : "were"} canceled with the work item; retry or accept holds ${canceledHeldDbTasks.length === 1 ? "it" : "them"} again.`
    : null;
  const operatorCanceledIds = operatorCanceledDbTasks.map((job) => `#${job.id}`).join(", ");
  const operatorCanceledLine = operatorCanceledDbTasks.length > 0
    ? `Database task${operatorCanceledDbTasks.length === 1 ? "" : "s"} ${operatorCanceledIds} held for the merge ${operatorCanceledDbTasks.length === 1 ? "was" : "were"} canceled outside this failure (by an operator); retry or accept leaves ${operatorCanceledDbTasks.length === 1 ? "it" : "them"} canceled, so no post-merge gate will apply ${operatorCanceledDbTasks.length === 1 ? "its" : "their"} database change: apply ${operatorCanceledDbTasks.length === 1 ? "it" : "them"} by hand after the merge if the merged code needs ${operatorCanceledDbTasks.length === 1 ? "it" : "them"}.`
    : null;
  const question = [
    `${workItemLabel(workItem)} failed${branch ? ` with branch ${branch} intact` : ""}.`,
    failedLine,
    retryLine,
    acceptLine,
    abandonLine,
    gatesLine,
    ...restoredLines,
    heldLine,
    operatorCanceledLine,
  ].filter(Boolean).join(" ");
  return {
    work_item_id: workItem.id,
    job_type: "human_input",
    title: `Recover failed work item: ${String(workItem.title || `WI#${workItem.id}`).slice(0, 120)}`.slice(0, 160),
    priority: "high",
    payload_json: JSON.stringify({
      review_type: WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE,
      choices: humanInputChoicesForReviewType(WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE),
      questions: [question],
      prompt: question,
      context: [failedLine, acceptLine, gatesLine, ...restoredLines, heldLine, operatorCanceledLine].filter(Boolean),
      failure_episode: workItemFailureEpisode(workItem),
      branch_name: branch || null,
      failed_job_ids: leaves.map((job) => Number(job.id)),
      acceptable_job_ids: acceptance.ok ? acceptance.acceptable.map((job) => Number(job.id)) : [],
      superseded_gate_job_ids: supersededGates.map((gate) => Number(gate.id)),
      restored_job_ids: restoration.restored.map((job) => Number(job.id)),
      rewired_held_dependents: restoration.rewires
        .filter((rewire) => rewire.db_task)
        .map((rewire) => ({
          job_id: Number(rewire.job.id),
          db_task_id: Number(rewire.db_task.id),
          to_job_ids: rewire.to_job_ids.map(Number),
        })),
      canceled_held_db_task_ids: canceledHeldDbTasks.map((job) => Number(job.id)),
      operator_canceled_db_task_ids: operatorCanceledDbTasks.map((job) => Number(job.id)),
    }),
  };
}

function describeUpstream(upstream) {
  const paths = upstream.paths.length > 0
    ? ` (${upstream.paths.slice(0, 3).join(", ")}${upstream.paths.length > 3 ? ` +${upstream.paths.length - 3} more` : ""})`
    : "";
  return `WI#${upstream.source_work_item_id} ${upstream.status}${paths}`;
}

/**
 * createJob() arguments for a completed work item whose upstream failed or was
 * canceled. A work item whose branch is already gone (a rebuild or abandon
 * answer deleted it and its transition then failed) has nothing left to
 * merge: it is offered only rebuild and abandon.
 */
export function crossWiUpstreamDispositionGateSpec(workItem, upstreams = []) {
  const upstreamList = upstreams.map(describeUpstream).join("; ");
  const upstreamIds = upstreams.map((upstream) => `WI#${upstream.source_work_item_id}`).join(", ");
  const hasBranch = !!String(workItem.branch_name || "").trim();
  const waitAvailable = hasBranch && crossWiUpstreamWaitAvailable(upstreams);
  const choices = humanInputChoicesForReviewType(CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE)
    .filter((choice) => waitAvailable || choice !== "wait");
  const question = (hasBranch
    ? [
      `${workItemLabel(workItem)} is complete but its merge is deferred: its branch carries unmerged edits handed off from ${upstreamList}, and it may only merge after ${upstreams.length === 1 ? "that work item merges" : "those work items merge"}.`,
      waitAvailable
        ? `wait: keep deferring until ${upstreamIds} ${upstreams.length === 1 ? "is" : "are"} recovered and merged.`
        : `${canceledCrossWiUpstreamsText(upstreams)}, so waiting is not offered.`,
      `rebuild: delete this branch with the inherited edits and replan WI#${workItem.id} from the current target branch (every task runs again).`,
      `abandon: cancel WI#${workItem.id} and delete its branch.`,
    ]
    : [
      `${workItemLabel(workItem)} is complete, but its branch with the edits handed off from ${upstreamList} was already deleted by an earlier answer that did not finish, so there is nothing left to merge.`,
      `rebuild: replan WI#${workItem.id} from the current target branch (every task runs again).`,
      `abandon: cancel WI#${workItem.id}.`,
    ]).join(" ");
  return {
    work_item_id: workItem.id,
    job_type: "human_input",
    title: `Upstream ${upstreamIds} will not merge: ${String(workItem.title || `WI#${workItem.id}`).slice(0, 100)}`.slice(0, 160),
    priority: "high",
    payload_json: JSON.stringify({
      review_type: CROSS_WI_UPSTREAM_DISPOSITION_REVIEW_TYPE,
      choices,
      questions: [question],
      prompt: question,
      context: upstreams.map(describeUpstream),
      upstream_work_items: upstreams,
      upstream_episodes: upstreams.map(crossWiUpstreamEpisode),
    }),
  };
}

/**
 * Operator-facing pointer for surfaces that refuse to merge a failed work
 * item: name its recovery gate when one is open.
 */
export function workItemFailureRecoveryHint(workItemId) {
  let gate = null;
  try {
    [gate] = activeWorkItemDispositionGates(workItemId, WORK_ITEM_FAILURE_DISPOSITION_REVIEW_TYPE);
  } catch {
    gate = null;
  }
  return gate
    ? `answer its recovery gate #${gate.id} (retry, accept or abandon): posse gate answer ${gate.id} <choice>`
    : `no recovery gate is open for it (the next run's gate maintenance opens one for failures from the last ${Math.round(WORK_ITEM_DISPOSITION_BACKFILL_WINDOW_MS / 86_400_000)} days)`;
}
