// Deterministic maintenance that a standalone merge/review command must finish
// before it advertises the resulting target branch as ready to push.

import { getJob, getLiveSchedulerBlockMessage, listJobs } from "../../queue/functions/index.js";
import { acquireLease, releaseLease } from "../../queue/functions/leases.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import {
  closeSharedConductor,
  hasSharedConductor,
} from "../../atlas/functions/v2/parse/conductor.js";
import { Worker } from "../../worker/classes/Worker.js";

const POST_MERGE_ATLAS_PURPOSES = new Set([
  "main-incremental",
  "main-merge",
  "wi-cleanup",
]);
const DEFAULT_BUDGET_MS = 10 * 60 * 1000;
const DEFAULT_MAX_JOBS = 8;

function queuedPostMergeAtlasJobs({ readyOnly = false } = {}) {
  const now = Date.now();
  return listJobs(["queued"])
    .filter((job) => job.job_type === "atlas_warm")
    .filter((job) => POST_MERGE_ATLAS_PURPOSES.has(String(parseJobPayload(job)?.purpose || "")))
    .filter((job) => {
      if (!readyOnly) return true;
      const readyAt = job.ready_at ? Date.parse(job.ready_at) : 0;
      return !Number.isFinite(readyAt) || readyAt <= now;
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export async function drainPostMergeAtlasWarmJobs({
  projectDir,
  budgetMs = DEFAULT_BUDGET_MS,
  maxJobs = DEFAULT_MAX_JOBS,
  onStatus = null,
} = {}) {
  const liveScheduler = getLiveSchedulerBlockMessage("main");
  if (liveScheduler) {
    return {
      ran: 0,
      remaining: queuedPostMergeAtlasJobs().length,
      deferred: "scheduler_live",
    };
  }

  const status = (message) => {
    if (typeof onStatus === "function") {
      try { onStatus(message); } catch { /* display callback only */ }
    }
  };
  const deadline = Date.now() + Math.max(1, Number(budgetMs) || DEFAULT_BUDGET_MS);
  const limit = Math.max(1, Number(maxJobs) || DEFAULT_MAX_JOBS);
  const ownerId = `merge-${process.pid}-atlas-closeout`;
  const inheritedSharedConductor = hasSharedConductor();
  let worker = null;
  let ran = 0;
  try {
    while (ran < limit && Date.now() < deadline) {
      const job = queuedPostMergeAtlasJobs({ readyOnly: true })[0];
      if (!job) break;
      worker ||= new Worker({
        projectDir,
        silent: true,
        nonInteractive: true,
      });
      const lease = acquireLease(job.id, ownerId, 900);
      if (!lease) break;
      const purpose = String(parseJobPayload(job)?.purpose || "atlas");
      const startedAt = Date.now();
      status(`Finishing ATLAS ${purpose} job #${job.id}...`);
      // Use the same entry point as the scheduler. Calling the deterministic
      // executor directly leaves the row in `leased`, never sets started_at,
      // and skips lease renewal while a real warm can run for minutes.
      await worker.execute({ ...job, _leaseToken: lease.leaseToken });
      ran += 1;
      const settled = getJob(job.id);
      const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      status(`ATLAS ${purpose} job #${job.id} ${settled?.status || "finished"} (${elapsedSec}s).`);
      if (settled?.status === "leased" || settled?.status === "running") {
        // A pre-attempt infrastructure failure is intentionally soft inside
        // the warm executor. Do not strand this standalone closeout lease.
        releaseLease(job.id, lease.leaseToken, "queued", {
          readyAt: new Date(Date.now() + 60_000).toISOString(),
        });
        break;
      }
      if (settled?.status === "queued") break;
    }
  } finally {
    if (worker) {
      try { await worker.disposeAgents?.("post_merge_closeout"); } catch { /* best effort */ }
    }
    if (worker && !inheritedSharedConductor) {
      try { await closeSharedConductor(); } catch { /* process exit also closes it */ }
    }
  }

  const remaining = queuedPostMergeAtlasJobs().length;
  return {
    ran,
    remaining,
    deferred: remaining > 0 ? "budget_or_runtime_defer" : null,
  };
}
