// lib/domains/worker/functions/helpers/verdicts/needs_replan.js

import { REPLAN_CANCELABLE_JOB_TYPES, STALE_CANCELABLE_JOB_STATUSES } from "../../../../../catalog/job.js";
import { TERMINAL_JOB_STATUSES } from "../../../../queue/functions/common.js";
import {
  getWorkItem,
  getAttempts,
  forceUpdateJobStatus,
  invalidateSessionLanesForWorkItem,
  listJobsByWorkItem,
  logEvent,
  runInTransaction,
  updateJobStatus,
} from "../../../../queue/functions/index.js";
import { parseJobPayload } from "../../../../queue/functions/payload.js";
import { cleanupArtifactDirs, wiScopeId } from "../../../../artifacts/functions/index.js";
import { C } from "../../../../../shared/format/functions/colors.js";
import { getMaxReplans } from "../../../../settings/functions/tunables.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../../../catalog/event.js";

function isLoopbackReplanResearchJob(job) {
  if (job?.job_type !== "research") return false;
  const payload = parseJobPayload(job);
  if (payload?._is_loopback === true) return true;
  return /^Research \(replan\):/.test(job?.title || "");
}

function collectScopedFiles(payload = {}) {
  const files = [
    ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
    ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
    ...(Array.isArray(payload.files_to_delete) ? payload.files_to_delete : []),
    ...(Array.isArray(payload.must_modify) ? payload.must_modify : []),
  ];
  return [...new Set(files.map((file) => String(file || "").replace(/\\/g, "/").trim()).filter(Boolean))];
}

function latestCommitHashForJob(jobId) {
  try {
    const attempts = getAttempts(jobId);
    for (let i = attempts.length - 1; i >= 0; i--) {
      const hash = String(attempts[i]?.commit_hash || "").trim();
      if (hash) return hash;
    }
  } catch {
    return null;
  }
  return null;
}

export function handle(job, verdict, ctx) {
  const { emitLog: log, spawnedJobs, spawnFromAssessor, reasonBrief } = ctx;

  // Cap replan cycles to prevent infinite research -> plan -> dev -> assess loops.
  const MAX_REPLANS = getMaxReplans();
  const allJobs = listJobsByWorkItem(job.work_item_id);
  const replanCount = allJobs.filter(isLoopbackReplanResearchJob).length;
  if (replanCount >= MAX_REPLANS) {
    runInTransaction(() => {
      log(`${C.red}[assessor] WI#${job.work_item_id} hit replan limit (${replanCount}/${MAX_REPLANS}) - escalating to human${C.reset}`);
      const changed = typeof ctx.updateJobStatus === "function"
        ? ctx.updateJobStatus("waiting_on_review")
        : updateJobStatus(job.id, "waiting_on_review");
      if (!changed) return;
      invalidateSessionLanesForWorkItem(job.work_item_id, "assessor_needs_replan");
      const escJob = spawnFromAssessor("failed", "human_input", {
        work_item_id: job.work_item_id,
        title: `Replan limit reached: ${job.title.slice(0, 60)}`,
        parent_job_id: job.id,
        priority: "urgent",
        model_tier: "cheap",
        payload_json: JSON.stringify({
          original_job_id: job.id,
          questions: [
            `WI#${job.work_item_id} has been replanned ${replanCount} times and the assessor wants another replan.\n` +
            `Reasons: ${verdict.reasons.join("; ")}\n` +
            "The task may be fundamentally blocked or poorly scoped. How should we proceed?",
          ],
          context: "Replan depth limit hit. Previous approaches keep failing assessment.",
          review_type: "replan_limit",
        }),
      });
      spawnedJobs.push(escJob);
      log(`${C.yellow}[assessor]${C.reset} spawned replan-limit review #${escJob.id}`);
    });
    return;
  }

  let changedJob = false;
  runInTransaction(() => {
    const changed = typeof ctx.updateJobStatus === "function"
      ? ctx.updateJobStatus("failed")
      : updateJobStatus(job.id, "failed");
    if (!changed) return;
    changedJob = true;
    invalidateSessionLanesForWorkItem(job.work_item_id, "assessor_needs_replan");
    log(`${C.yellow}[assessor] REPLAN${C.reset} WI#${job.work_item_id} job #${job.id}: ${job.title}${reasonBrief}`);

    // Cancel stale descendants from the old plan, including review-parked jobs.
    // Otherwise an old review gate can later requeue a superseded branch.
    const staleStatuses = new Set(STALE_CANCELABLE_JOB_STATUSES);
    const terminalStatuses = new Set(TERMINAL_JOB_STATUSES);
    const staleJobIds = new Set();
    let canceledCount = 0;
    for (const sib of allJobs) {
      if (staleStatuses.has(sib.status) && REPLAN_CANCELABLE_JOB_TYPES.has(sib.job_type) && sib.id !== job.id) {
        if (!forceUpdateJobStatus(sib.id, "canceled")) continue;
        staleJobIds.add(sib.id);
        canceledCount++;
        logEvent({
          job_id: sib.id,
          work_item_id: job.work_item_id,
          event_type: EVENT_TYPES.JOB_CANCELED_BY_REPLAN,
          actor_type: EVENT_ACTORS.ASSESSOR,
          message: `Canceled (stale plan) - replan triggered by job #${job.id}`,
        });
      }
    }
    for (const child of allJobs) {
      if (child.job_type !== "human_input") continue;
      if (!staleJobIds.has(child.parent_job_id)) continue;
      if (terminalStatuses.has(child.status)) continue;
      if (!forceUpdateJobStatus(child.id, "canceled")) continue;
      canceledCount++;
      logEvent({
        job_id: child.id,
        work_item_id: job.work_item_id,
        event_type: EVENT_TYPES.JOB_CANCELED_BY_REPLAN,
        actor_type: EVENT_ACTORS.ASSESSOR,
        message: `Canceled review gate for stale job #${child.parent_job_id} - replan triggered by job #${job.id}`,
      });
    }
    if (canceledCount > 0) {
      log(`${C.yellow}[assessor]${C.reset} WI#${job.work_item_id} canceled ${canceledCount} stale job(s)`);
    }

    const wi = getWorkItem(job.work_item_id);
    const wiTitle = (wi?.title || job.title).slice(0, 60);
    const originalPayload = parseJobPayload(job);
    const originalScopedFiles = collectScopedFiles(originalPayload);
    const originalCommitHash = latestCommitHashForJob(job.id);
    const reResearchJob = spawnFromAssessor("failed", "research", {
      work_item_id: job.work_item_id,
      title: `Research (replan): ${wiTitle}`,
      parent_job_id: job.id,
      priority: job.priority,
      model_tier: "standard",
      reasoning_effort: "medium",
      payload_json: JSON.stringify({
        _is_loopback: true,
        _assessment_replan: true,
        replan_reason: verdict.reasons.join("\n"),
        original_job_id: job.id,
        original_job_type: job.job_type,
        original_task_mode: originalPayload.task_mode || "code",
        original_title: job.title,
        original_commit_hash: originalCommitHash,
        original_scoped_files: originalScopedFiles,
        wi_branch_name: wi?.branch_name || null,
        wi_merge_base_hash: null,
        instructions: `Re-research for replan. Previous approach failed:\n${verdict.reasons.join("\n")}\nInvestigate the current codebase state and produce an updated research brief.`,
      }),
    });
    spawnedJobs.push(reResearchJob);
    log(`${C.yellow}[assessor]${C.reset} spawned replan research #${reResearchJob.id}`);
  });
  if (!changedJob) return;
  try { cleanupArtifactDirs(wiScopeId(job.work_item_id), null, { keepArtifacts: true }); }
  catch { /* best effort */ }
}
