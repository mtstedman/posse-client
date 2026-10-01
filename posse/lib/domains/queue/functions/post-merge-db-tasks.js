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
//
// Such a task must have no dependents: anything waiting on it waits for the
// merge, and the merge waits for it. Code that needs the change works against
// the committed file (the migration), not the applied database, so a
// dependent is rewired onto the task's own upstream instead -- by the plan
// compiler, and again when the hold is applied for plans compiled before.
// The compiler records what it rewired on the task
// (POST_MERGE_DB_COMPILE_REWIRES_KEY): a held task carries those dependents
// into its hold record, so the post-merge gate can say that merged code
// expects the database change; a task that runs before the merge after all
// gives the dependents that have not started their wait on it back.
//
// A plan that supersedes an older one recreates the database tasks it still
// needs. An older task revived after that (a review rejection requeues every
// leaf job, a failure recovery re-holds tasks canceled with the work item) is
// a duplicate of the newer one: it is canceled instead of held, so the merge
// opens one gate per migration.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  POST_MERGE_DB_TASK_REVIEW_TYPE,
  humanInputChoicesForReviewType,
} from "../../../catalog/human-input.js";
import {
  DB_TASK_PRE_MERGE_POLICIES,
  DB_TASK_PRE_MERGE_POLICY_VALUES,
} from "../../../catalog/settings.js";
import { DEADLOCK_TERMINAL_STATUSES, FAILED_JOB_STATUSES, TERMINAL_JOB_STATUSES_SQL } from "../../../catalog/job.js";
import { rewireDependencyChain } from "./dependencies.js";
import { parseJobPayload } from "./payload.js";

export const POST_MERGE_DB_HOLD_KEY = "_post_merge_db_hold";
// Dependents the plan compiler moved off this database task.
export const POST_MERGE_DB_COMPILE_REWIRES_KEY = "_post_merge_db_compile_rewires";
// Set on a database task canceled as the duplicate of a newer plan's task.
export const POST_MERGE_DB_SUPERSEDED_KEY = "_post_merge_db_superseded";

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

/**
 * What a dependent of database task `dbJob` waits on once it stops waiting on
 * the task: the task's own hard dependencies, looking through same-work-item
 * database tasks (a chain of them is bypassed as a whole). Typically this is
 * the job that wrote the migration file.
 */
export function dbTaskBypassUpstreamIds(dbJob) {
  if (!dbJob?.id) return [];
  const db = getDb();
  const dependencies = db.prepare(`
    SELECT dep.*
    FROM job_dependencies jd
    JOIN jobs dep ON dep.id = jd.depends_on_job_id
    WHERE jd.job_id = ? AND jd.dependency_kind = 'hard'
    ORDER BY dep.id
  `);
  const upstream = [];
  const seen = new Set([Number(dbJob.id)]);
  const pending = [Number(dbJob.id)];
  while (pending.length > 0) {
    for (const dep of dependencies.all(pending.shift())) {
      const depId = Number(dep.id);
      if (seen.has(depId)) continue;
      seen.add(depId);
      if (Number(dep.work_item_id) === Number(dbJob.work_item_id) && isDbTaskJob(dep)) pending.push(depId);
      else upstream.push(depId);
    }
  }
  return upstream;
}

/**
 * Move `dependentId`'s hard edge on database task `dbJob` to the task's
 * bypass upstream, atomically and cycle-checked. Returns
 * { rewired, upstreamIds, inserted, skipped }; nothing changes when the task
 * has no upstream or every replacement would close a cycle.
 */
export function rewireDependentAroundDbTask(dependentId, dbJob, upstreamIds = dbTaskBypassUpstreamIds(dbJob)) {
  const ids = upstreamIds.map(Number).filter((id) => id !== Number(dependentId));
  if (ids.length === 0) return { rewired: false, upstreamIds: ids, inserted: [], skipped: [] };
  const result = rewireDependencyChain(Number(dependentId), Number(dbJob.id), ids, "hard", { returnDetails: true });
  return { rewired: result.rewired, upstreamIds: ids, inserted: result.inserted, skipped: result.skipped };
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

/** A dependent the hold moved off the task: who, and what it waits on now. */
export function rewiredDependentSummary(job, { dbJobId, upstreamJobIds = [] } = {}) {
  return {
    job_id: Number(job.id),
    title: String(job.title || "").slice(0, 200),
    job_type: job.job_type,
    from_job_id: Number(dbJobId),
    to_job_ids: upstreamJobIds.map(Number),
  };
}

function mergedDependentEntries(previous, next) {
  const byId = new Map((Array.isArray(previous) ? previous : []).map((entry) => [Number(entry.job_id), entry]));
  for (const entry of Array.isArray(next) ? next : []) byId.set(Number(entry.job_id), entry);
  return [...byId.values()];
}

/** Dependents the plan compiler moved off database task `job` ([] when none). */
export function compiledRewiredDependents(job) {
  const entries = parseJobPayload(job)[POST_MERGE_DB_COMPILE_REWIRES_KEY];
  return Array.isArray(entries) ? entries.filter((entry) => Number(entry?.job_id) > 0) : [];
}

/** The payload of database task `job` with compile-time rewires `entries` added. */
export function compiledRewiresPayload(job, entries = []) {
  return {
    ...parseJobPayload(job),
    [POST_MERGE_DB_COMPILE_REWIRES_KEY]: mergedDependentEntries(
      compiledRewiredDependents(job),
      entries.map((entry) => ({ ...entry, source: "plan_compile" })),
    ),
  };
}

/** Every dependent moved off a held task: by the plan compiler or by the hold. */
export function postMergeDbRewiredDependents(job) {
  return mergedDependentEntries(compiledRewiredDependents(job), postMergeDbHoldRecord(job)?.rewired_dependents);
}

export function heldPostMergeDbPayload(job, {
  dependencyJobIds = [],
  canceledDependents = [],
  rewiredDependents = [],
  heldAt = new Date().toISOString(),
} = {}) {
  // A re-applied hold (the first park lost its lease) keeps the dependents
  // the earlier pass already canceled or rewired. The compiler's rewires are
  // carried in too: those dependents run, and merge, without this task.
  const previous = postMergeDbHoldRecord(job);
  return {
    ...parseJobPayload(job),
    [POST_MERGE_DB_HOLD_KEY]: {
      reason: "unmerged_file_dependency",
      dependency_job_ids: dependencyJobIds.map(Number),
      canceled_dependents: mergedDependentEntries(previous?.canceled_dependents, canceledDependents),
      rewired_dependents: mergedDependentEntries(
        mergedDependentEntries(compiledRewiredDependents(job), previous?.rewired_dependents),
        rewiredDependents,
      ),
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

/** Operator-facing line naming the dependents the hold rewired; empty when none. */
export function rewiredDependentsNotice(record) {
  const entries = Array.isArray(record?.rewired_dependents) ? record.rewired_dependents : [];
  if (entries.length === 0) return "";
  const shown = entries.slice(0, 8).map((entry) => {
    const upstream = (Array.isArray(entry.to_job_ids) ? entry.to_job_ids : []).map((id) => `#${id}`).join(", ");
    return `#${entry.job_id} "${String(entry.title || "").slice(0, 80)}" (now after ${upstream || "nothing"})`;
  });
  const more = entries.length > shown.length ? `, +${entries.length - shown.length} more` : "";
  return `Rewired to run now against the committed files instead of the applied database: ${shown.join(", ")}${more}.`;
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

const SCHEMA_DEPENDENTS_SHOWN = 8;

const SCHEMA_DEPENDENT_JOB_TYPES = new Set(["dev", "fix"]);

/**
 * Merged code that expects the database change `heldJob` applies: the
 * dependents moved off it (compiler or hold), and the other code jobs of the
 * work item built on the files it applies (hard dependents of its upstream,
 * typically the migration-file job; WI 169's API waited on the migration
 * file, not on the apply task). Only delivered jobs, i.e. merged: one that
 * succeeded, or one that failed and a fix below it succeeded (WI 169's API
 * 2184 failed assessment and fix 2238 completed it; its committed code and
 * the fix merged together).
 */
export function mergedSchemaDependents(heldJob) {
  const db = getDb();
  const candidates = new Map();
  for (const entry of postMergeDbRewiredDependents(heldJob)) {
    candidates.set(Number(entry.job_id), { title: entry.title, job_type: entry.job_type });
  }
  const upstreamIds = dbTaskBypassUpstreamIds(heldJob).filter((id) => id > 0);
  if (upstreamIds.length > 0) {
    const rows = db.prepare(`
      SELECT j.id, j.title, j.job_type, j.payload_json
      FROM job_dependencies jd
      JOIN jobs j ON j.id = jd.job_id
      WHERE jd.depends_on_job_id IN (${upstreamIds.map(() => "?").join(",")})
        AND jd.dependency_kind = 'hard'
        AND j.work_item_id = ?
        AND j.id != ?
      ORDER BY j.id
    `).all(...upstreamIds, heldJob.work_item_id, heldJob.id);
    for (const row of rows) {
      if (!SCHEMA_DEPENDENT_JOB_TYPES.has(row.job_type) || isDbTaskJob(row)) continue;
      if (!candidates.has(Number(row.id))) candidates.set(Number(row.id), { title: row.title, job_type: row.job_type });
    }
  }
  if (candidates.size === 0) return [];
  const statusOf = db.prepare(`SELECT status FROM jobs WHERE id = ?`);
  const fixesOf = db.prepare(`SELECT id, status FROM jobs WHERE parent_job_id = ? AND job_type = 'fix' AND work_item_id = ?`);
  const delivered = (jobId) => {
    const status = statusOf.get(jobId)?.status;
    if (status === "succeeded") return true;
    if (!FAILED_JOB_STATUSES.includes(status)) return false;
    const seen = new Set([jobId]);
    const pending = [jobId];
    while (pending.length > 0) {
      for (const fix of fixesOf.all(pending.shift(), heldJob.work_item_id)) {
        const fixId = Number(fix.id);
        if (seen.has(fixId)) continue;
        if (fix.status === "succeeded") return true;
        seen.add(fixId);
        pending.push(fixId);
      }
    }
    return false;
  };
  return [...candidates.entries()]
    .filter(([jobId]) => delivered(jobId))
    .sort(([a], [b]) => a - b)
    .map(([jobId, entry]) => ({
      job_id: jobId,
      title: String(entry.title || "").slice(0, 200),
      job_type: entry.job_type || null,
    }));
}

/**
 * Deploy ordering for the post-merge gate. Code that needed the change merged
 * without waiting for it (it was rewired onto the migration file), and a
 * repository that deploys its target branch on merge may already run it.
 */
export function postMergeDbDeployNotice(schemaDependents = []) {
  if (schemaDependents.length === 0) {
    return "If the merged code uses this database change, apply it before deploying the merged change (right away if the target branch deploys on merge); if the change only works once the new code is live, run it after deploying.";
  }
  const shown = schemaDependents.slice(0, SCHEMA_DEPENDENTS_SHOWN)
    .map((entry) => `#${entry.job_id} "${String(entry.title || "").slice(0, 80)}"`);
  const more = schemaDependents.length > shown.length ? `, +${schemaDependents.length - shown.length} more` : "";
  return [
    `The merged code expects this database change: ${shown.join(", ")}${more} merged without waiting for it.`,
    "Apply it before deploying the merged change; if the target branch deploys on merge, that code may already be live, so run it now.",
  ].join(" ");
}

/** createJob() arguments for the post-merge operator gate of a held task. */
export function postMergeDbGateJobSpec(heldJob, workItem = null) {
  const record = postMergeDbHoldRecord(heldJob) || {};
  const taskTitle = String(heldJob.title || "").slice(0, 120);
  const workItemLabel = `WI#${heldJob.work_item_id}${workItem?.title ? ` "${String(workItem.title).slice(0, 80)}"` : ""}`;
  const canceledDependents = Array.isArray(record.canceled_dependents) ? record.canceled_dependents : [];
  const dependentsNotice = canceledDependentsNotice(record);
  const schemaDependents = mergedSchemaDependents(heldJob);
  const deployNotice = postMergeDbDeployNotice(schemaDependents);
  const question = [
    `Post-merge database task ready: ${workItemLabel} is merged.`,
    `Run database task #${heldJob.id} "${taskTitle}" against the project database now?`,
    deployNotice,
    "Answer run to apply it, or skip to drop the task.",
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
      context: `${deployNotice} ${dependentsNotice}`,
      deploy_notice: deployNotice,
      schema_dependents: schemaDependents,
      dependency_job_ids: Array.isArray(record.dependency_job_ids) ? record.dependency_job_ids : [],
      canceled_dependents: canceledDependents,
    }),
  };
}

const SUPERSEDING_EXCLUDED_STATUSES = new Set(DEADLOCK_TERMINAL_STATUSES);
// A migration file lives under one of these directories (docs/postgres/
// updates/015_risk_games.sql, db/migrate/..., app/migrations/...).
const MIGRATION_DIR_SEGMENTS = new Set(["updates", "migrations", "migration", "migrate"]);
// Ledgers and manifests that every migration edits (migration-chain.json,
// SCHEMA.md, VERSION) never identify one migration, wherever they live.
const NON_MIGRATION_EXTENSIONS = new Set([".json", ".md", ".markdown", ".txt", ".yml", ".yaml", ".toml", ".lock", ".csv", ".log"]);
const NAMED_PATH_PATTERN = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]+/g;

function normalizedTitle(job) {
  return String(job?.title || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** The normalized path when `path` is a migration file, else null. */
function migrationPathKey(path, { allowBareSql = false } = {}) {
  const normalized = String(path || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
  if (!normalized) return null;
  const segments = normalized.split("/");
  const base = segments.pop();
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  if (!ext || NON_MIGRATION_EXTENSIONS.has(ext)) return null;
  if (segments.some((segment) => MIGRATION_DIR_SEGMENTS.has(segment))) return normalized;
  return allowBareSql && ext === ".sql" ? normalized : null;
}

// One path names the other: equal, or a suffix at a directory boundary (a
// task text naming "updates/015_risk_games.sql" or just the file name).
function sameMigrationPath(left, right) {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * Which migration a database task applies, as migration file paths: the
 * migration files its upstream jobs created (the migration job, typically);
 * failing that, the ones they modified (a replan reworking the same file);
 * failing that, the migration paths its own title and task text name. Shared
 * ledgers every migration edits never count: wowiekowie's "apply 015" and
 * "apply 016" both follow jobs that edit migration-chain.json, VERSION and
 * SCHEMA.md, and are different migrations.
 */
function dbTaskMigrationPaths(job) {
  const upstreamIds = new Set([
    ...dbTaskBypassUpstreamIds(job),
    ...(postMergeDbHoldRecord(job)?.dependency_job_ids || []),
  ].map(Number));
  const created = new Set();
  const modified = new Set();
  const read = getDb().prepare(`SELECT payload_json FROM jobs WHERE id = ?`);
  for (const id of upstreamIds) {
    const row = read.get(id);
    if (!row) continue;
    const payload = parseJobPayload(row);
    for (const [field, into] of [["files_to_create", created], ["files_to_modify", modified]]) {
      for (const file of Array.isArray(payload[field]) ? payload[field] : []) {
        const key = migrationPathKey(file);
        if (key) into.add(key);
      }
    }
  }
  if (created.size > 0) return created;
  if (modified.size > 0) return modified;
  const payload = parseJobPayload(job);
  const named = new Set();
  for (const text of [job?.title, payload.task_spec]) {
    for (const match of String(text || "").matchAll(NAMED_PATH_PATTERN)) {
      const key = migrationPathKey(match[0], { allowBareSql: true });
      if (key) named.add(key);
    }
  }
  return named;
}

/**
 * Whether two database tasks apply the same change: they name the same
 * migration file, or, when either names none, they have the same title.
 */
function sameDbTaskChange(job, candidate, { title = normalizedTitle(job), paths = dbTaskMigrationPaths(job) } = {}) {
  const candidatePaths = dbTaskMigrationPaths(candidate);
  if (paths.size > 0 && candidatePaths.size > 0) {
    return [...paths].some((path) => [...candidatePaths].some((other) => sameMigrationPath(path, other)));
  }
  return !!title && normalizedTitle(candidate) === title;
}

/**
 * The newer database task that makes `job` a stale duplicate, or null: a
 * database task of the same work item, compiled by a later plan than `job`'s,
 * not canceled or failed, that applies the same migration file (or, without
 * one to compare, has the same title; sameDbTaskChange). `rows` defaults to
 * the work item's jobs.
 */
export function supersedingPostMergeDbTask(job, rows = null) {
  if (!isDbTaskJob(job)) return null;
  const planId = Number(job.parent_job_id);
  if (!(planId > 0)) return null;
  const jobs = Array.isArray(rows)
    ? rows
    : getDb().prepare(`SELECT * FROM jobs WHERE work_item_id = ? ORDER BY id`).all(job.work_item_id);
  const planIds = new Set(jobs.filter((row) => row.job_type === "plan").map((row) => Number(row.id)));
  if (!planIds.has(planId)) return null;
  const candidates = jobs
    .filter((row) => Number(row.id) !== Number(job.id)
      && Number(row.work_item_id) === Number(job.work_item_id)
      && isDbTaskJob(row)
      && !SUPERSEDING_EXCLUDED_STATUSES.has(row.status)
      && planIds.has(Number(row.parent_job_id))
      && Number(row.parent_job_id) > planId)
    .sort((a, b) => Number(b.id) - Number(a.id));
  if (candidates.length === 0) return null;
  const title = normalizedTitle(job);
  const paths = dbTaskMigrationPaths(job);
  return candidates.find((candidate) => sameDbTaskChange(job, candidate, { title, paths })) || null;
}

// Work-item metadata key: the database tasks that already ran against the
// project database. A replan of a discarded branch cancels every succeeded
// job of the old plan, database tasks included, so the job rows alone forget
// on the next rebuild that the change is applied (queue-store
// rememberAppliedDbTasks writes it; discardedPlanContext tells the planner).
export const APPLIED_DB_TASKS_KEY = "applied_db_tasks";

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The database tasks recorded on the work item as already run ({ job_id, title, ... }). */
export function recordedAppliedDbTasks(workItem) {
  const entries = parseMetadata(workItem?.metadata_json)[APPLIED_DB_TASKS_KEY];
  return Array.isArray(entries) ? entries.filter((entry) => Number(entry?.job_id) > 0) : [];
}

/**
 * Database tasks among `jobs` that ran against the project database: they
 * succeeded, or a replan canceled them after an implementation attempt
 * succeeded (a replan recorded before the work item kept this list).
 */
export function ranDbTaskJobs(jobs = []) {
  const succeededAttempt = getDb().prepare(`
    SELECT 1 FROM job_attempts
    WHERE job_id = ? AND attempt_kind = 'implementation' AND status = 'succeeded'
    LIMIT 1
  `);
  return jobs.filter((job) => isDbTaskJob(job) && (
    job.status === "succeeded"
    || (job.status === "canceled" && !!parseJobPayload(job)._superseded_by_replan && !!succeededAttempt.get(job.id))
  ));
}

/** Recorded entries plus the tasks of `jobs` that ran, by job id. */
export function appliedDbTaskEntries(workItem, jobs = [], { at = new Date().toISOString() } = {}) {
  const byId = new Map(recordedAppliedDbTasks(workItem).map((entry) => [Number(entry.job_id), entry]));
  for (const job of ranDbTaskJobs(jobs)) {
    if (byId.has(Number(job.id))) continue;
    byId.set(Number(job.id), {
      job_id: Number(job.id),
      title: String(job.title || "").slice(0, 200),
      job_type: job.job_type,
      recorded_at: at,
    });
  }
  return [...byId.values()].sort((a, b) => Number(a.job_id) - Number(b.job_id));
}

/**
 * Payload of a database task canceled as the duplicate of `superseding`.
 * A failure-cancel mark is dropped so recovery does not hold it again.
 */
export function supersededPostMergeDbPayload(job, superseding, { at = new Date().toISOString() } = {}) {
  const payload = parseJobPayload(job);
  const hold = postMergeDbHoldRecord(job);
  if (hold?.canceled_with_work_item) {
    const { canceled_with_work_item: _canceled, ...rest } = hold;
    payload[POST_MERGE_DB_HOLD_KEY] = rest;
  }
  payload[POST_MERGE_DB_SUPERSEDED_KEY] = {
    superseded_by_job_id: Number(superseding.id),
    superseding_plan_job_id: Number(superseding.parent_job_id) || null,
    superseded_at: at,
  };
  return payload;
}

export function supersededPostMergeDbMessage(job, superseding) {
  return `Canceled database task #${job.id}: plan #${superseding.parent_job_id} replaced it with database task #${superseding.id}, which applies the same change; only that one runs after the merge`;
}
