// Job-level dependency graph primitives. Edges live in the
// `job_dependencies` table; each edge has a `dependency_kind` of
// "hard" (must succeed) or "soft" (advisory). The graph supports
// safe cycle-checked inserts, atomic rewires used by the assessor's
// failure handlers, and a read-side deadlock detector that finds
// queued jobs whose hard deps cannot ever be satisfied.
//
// cancelDeadlockedJobsAtomic stays in queue/index.js because it
// composes with session-lane invalidation that index.js owns; this
// module only owns the graph itself and the detector that feeds it.

import { getDb } from "../../../shared/storage/functions/index.js";
import {
  DEADLOCK_TERMINAL_STATUSES_SQL,
  runImmediateTransaction,
} from "./common.js";
import { logEvent } from "./events.js";
import { notifyQueueStateChanged } from "./wakeups.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

function readJob(id) {
  return getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
}

export function addDependency(jobId, dependsOnId, kind = "hard") {
  const db = getDb();
  if (jobId === dependsOnId) {
    const job = readJob(jobId);
    logEvent({
      work_item_id: job?.work_item_id || null,
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_DEPENDENCY_CYCLE,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Ignored self-dependency for job #${jobId}`,
    });
    return false;
  }
  const execute = () => {
    const cycle = db.prepare(`
      WITH RECURSIVE dep_chain(id) AS (
        SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?
        UNION ALL
        SELECT jd.depends_on_job_id FROM job_dependencies jd
        JOIN dep_chain dc ON jd.job_id = dc.id
      )
      SELECT 1 AS found FROM dep_chain WHERE id = ? LIMIT 1
    `).get(dependsOnId, jobId);
    if (cycle) {
      const job = readJob(jobId);
      logEvent({
        work_item_id: job?.work_item_id || null,
        job_id: jobId,
        event_type: EVENT_TYPES.JOB_DEPENDENCY_CYCLE,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Ignored dependency #${jobId} → #${dependsOnId} (would create cycle)`,
      });
      return false;
    }
    const result = db.prepare(`
      INSERT OR IGNORE INTO job_dependencies (job_id, depends_on_job_id, dependency_kind)
      VALUES (?, ?, ?)
    `).run(jobId, dependsOnId, kind);
    if ((result?.changes || 0) > 0) {
      const job = readJob(jobId);
      notifyQueueStateChanged({
        reason: "job_dependency_added",
        jobId,
        workItemId: job?.work_item_id,
      });
    }
    return true;
  };

  if (db.inTransaction) return execute();
  return runImmediateTransaction(db, execute);
}

/**
 * Remove a specific dependency.
 * Used when rewiring: replace a failed dep with a fix job dep.
 */
export function removeDependency(jobId, dependsOnId, opts = {}) {
  const db = getDb();
  const result = db.prepare(`DELETE FROM job_dependencies WHERE job_id = ? AND depends_on_job_id = ?`)
    .run(jobId, dependsOnId);
  const removed = (result?.changes || 0) > 0;
  if (removed) {
    const job = readJob(jobId);
    logEvent({
      work_item_id: job?.work_item_id || null,
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_DEPENDENCY_REMOVED,
      actor_type: opts?.actorType || EVENT_ACTORS.SYSTEM,
      actor_id: opts?.actorId || null,
      message: opts?.message || `Removed dependency #${jobId} -> #${dependsOnId}`,
    });
    notifyQueueStateChanged({
      reason: "job_dependency_removed",
      jobId,
      workItemId: job?.work_item_id,
    });
  }
  return removed;
}

/**
 * Atomically replace a dependency: remove old → add new in one transaction.
 * Prevents crash-between-calls from leaving orphaned dependency edges.
 * Detects cycles before INSERT — concurrent rewires across assessors must
 * not produce a back-edge that would cycle the graph.
 */
export function rewireDependency(jobId, oldDependsOn, newDependsOn, kind = "hard") {
  const db = getDb();
  if (jobId === newDependsOn) {
    logEvent({
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_DEPENDENCY_CYCLE,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Refused rewire #${jobId} → #${newDependsOn} (self-dependency)`,
    });
    return false;
  }
  let rewired = false;
  const execute = () => {
    // Check the cycle before touching the old edge: an aborted rewire must
    // not commit the deletion and leave the job with no blocker. The old
    // edge can't produce a false positive — any chain that traverses it has
    // already reached jobId, which is the detection condition itself.
    const cycle = db.prepare(`
      WITH RECURSIVE dep_chain(id) AS (
        SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?
        UNION ALL
        SELECT jd.depends_on_job_id FROM job_dependencies jd
        JOIN dep_chain dc ON jd.job_id = dc.id
      )
      SELECT 1 AS found FROM dep_chain WHERE id = ? LIMIT 1
    `).get(newDependsOn, jobId);
    if (cycle) {
      const job = readJob(jobId);
      logEvent({
        work_item_id: job?.work_item_id || null,
        job_id: jobId,
        event_type: EVENT_TYPES.JOB_DEPENDENCY_CYCLE,
        actor_type: EVENT_ACTORS.SYSTEM,
        message: `Refused rewire #${jobId} → #${newDependsOn} (would create cycle)`,
      });
      return;
    }
    db.prepare(`DELETE FROM job_dependencies WHERE job_id = ? AND depends_on_job_id = ?`)
      .run(jobId, oldDependsOn);
    db.prepare(`INSERT OR IGNORE INTO job_dependencies (job_id, depends_on_job_id, dependency_kind) VALUES (?, ?, ?)`)
      .run(jobId, newDependsOn, kind);
    rewired = true;
    const job = readJob(jobId);
    notifyQueueStateChanged({
      reason: "job_dependency_rewired",
      jobId,
      workItemId: job?.work_item_id,
    });
  };
  if (db.inTransaction) execute();
  else runImmediateTransaction(db, execute);
  return rewired;
}

export function rewireDependencyChain(jobId, oldDependsOn, newDependsOnIds, kind = "hard", opts = {}) {
  const db = getDb();
  const returnDetails = !!opts?.returnDetails;
  const details = {
    rewired: false,
    inserted: [],
    skipped: [],
  };
  const replacements = Array.from(new Set(
    (Array.isArray(newDependsOnIds) ? newDependsOnIds : [newDependsOnIds])
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
  ));
  if (replacements.length === 0) return returnDetails ? details : false;

  const candidates = [];
  for (const replacementId of replacements) {
    if (replacementId === jobId) {
      details.skipped.push({ id: replacementId, reason: "self_dependency" });
    } else {
      candidates.push(replacementId);
    }
  }

  if (details.skipped.length > 0) {
    logEvent({
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_DEPENDENCY_CYCLE,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Refused ${details.skipped.length} replacement(s) for #${jobId}: ${details.skipped.map((entry) => `#${entry.id} (${entry.reason})`).join(", ")}`,
      event_json: JSON.stringify({ skipped: details.skipped }),
    });
  }

  if (candidates.length > 0) {
    const execute = () => {
      const accepted = [];
      for (const replacementId of candidates) {
        const cycle = db.prepare(`
          WITH RECURSIVE dep_chain(id) AS (
            SELECT depends_on_job_id FROM job_dependencies WHERE job_id = ?
            UNION ALL
            SELECT jd.depends_on_job_id FROM job_dependencies jd
            JOIN dep_chain dc ON jd.job_id = dc.id
          )
          SELECT 1 AS found FROM dep_chain WHERE id = ? LIMIT 1
        `).get(replacementId, jobId);
        if (cycle) {
          details.skipped.push({ id: replacementId, reason: "cycle" });
          continue;
        }
        accepted.push(replacementId);
      }
      if (accepted.length === 0) return;

      db.prepare(`DELETE FROM job_dependencies WHERE job_id = ? AND depends_on_job_id = ?`)
        .run(jobId, oldDependsOn);
      for (const replacementId of accepted) {
        db.prepare(`INSERT OR IGNORE INTO job_dependencies (job_id, depends_on_job_id, dependency_kind) VALUES (?, ?, ?)`)
          .run(jobId, replacementId, kind);
      }
      details.inserted = accepted;
      details.rewired = true;
      const job = readJob(jobId);
      notifyQueueStateChanged({
        reason: "job_dependency_rewired",
        jobId,
        workItemId: job?.work_item_id,
      });
    };
    if (db.inTransaction) execute();
    else runImmediateTransaction(db, execute);
  }

  const cycleSkips = details.skipped.filter((entry) => entry.reason === "cycle");
  if (cycleSkips.length > 0) {
    const job = readJob(jobId);
    logEvent({
      work_item_id: job?.work_item_id || null,
      job_id: jobId,
      event_type: EVENT_TYPES.JOB_DEPENDENCY_CYCLE,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: `Skipped ${cycleSkips.length} cycle-inducing replacement(s) for #${jobId}: ${cycleSkips.map((entry) => `#${entry.id}`).join(", ")}`,
      event_json: JSON.stringify({ skipped: cycleSkips }),
    });
  }

  return returnDetails ? details : details.rewired;
}

export function getDependencies(jobId) {
  const db = getDb();
  return db.prepare(`
    SELECT jd.*, dep.status as dep_status, dep.title as dep_title
    FROM job_dependencies jd
    JOIN jobs dep ON dep.id = jd.depends_on_job_id
    WHERE jd.job_id = ?
  `).all(jobId);
}

export function getUnmetDependencies(jobId) {
  const db = getDb();
  return db.prepare(`
    SELECT jd.*, dep.status as dep_status, dep.title as dep_title
    FROM job_dependencies jd
    JOIN jobs dep ON dep.id = jd.depends_on_job_id
    WHERE jd.job_id = ?
      AND jd.dependency_kind = 'hard'
      AND dep.status != 'succeeded'
  `).all(jobId);
}

/**
 * Get all dependencies in one query (for efficient display rendering).
 * Returns array of { job_id, depends_on_job_id, dependency_kind }.
 */
export function getAllDependencies() {
  const db = getDb();
  return db.prepare(`SELECT job_id, depends_on_job_id, dependency_kind FROM job_dependencies`).all();
}

/**
 * Get jobs that depend on a given job (reverse lookup).
 */
export function getDependents(jobId) {
  const db = getDb();
  return db.prepare(`
    SELECT jd.*, j.title as job_title, j.status as job_status
    FROM job_dependencies jd
    JOIN jobs j ON j.id = jd.job_id
    WHERE jd.depends_on_job_id = ?
  `).all(jobId);
}

/**
 * Detect deadlocks: queued jobs whose hard deps will never be met.
 * A single failed/dead_letter/canceled hard dependency is sufficient because a
 * hard dependency can only be satisfied by "succeeded".
 */
export function findDeadlockedJobs() {
  const db = getDb();
  // Only treat truly terminal dependency states as deadlocked.
  // blocked and waiting_on_review are recoverable — a human can unblock them
  // or the review can complete — so they must NOT trigger cancellation.
  return db.prepare(`
    SELECT j.*,
      (SELECT GROUP_CONCAT('#' || dep.id || ' (' || dep.status || ')', ', ')
       FROM job_dependencies jd
       JOIN jobs dep ON dep.id = jd.depends_on_job_id
       WHERE jd.job_id = j.id
         AND jd.dependency_kind = 'hard'
         AND dep.status IN (${DEADLOCK_TERMINAL_STATUSES_SQL})
      ) AS failed_deps
    FROM jobs j
    WHERE j.status = 'queued'
      AND EXISTS (
        SELECT 1
        FROM job_dependencies jd
        JOIN jobs dep ON dep.id = jd.depends_on_job_id
        WHERE jd.job_id = j.id
          AND jd.dependency_kind = 'hard'
          AND dep.status IN (${DEADLOCK_TERMINAL_STATUSES_SQL})
      )
  `).all();
}
