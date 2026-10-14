import { getDb } from "../../../shared/storage/functions/index.js";
import { SCHEDULER_SELECTION_POLICY as POLICY } from "../../../catalog/scheduler-selection.js";
import { TERMINAL_JOB_STATUSES_SQL } from "./common.js";
import { finalReviewScope } from "../../assessment/functions/final-review-snapshot.js";
import { parseJobPayload } from "./payload.js";
import { findLockRowOverlap } from "./work-item-order.js";

function scopeRows(job) {
  const payload = parseJobPayload(job);
  if (!["dev", "fix", "promote"].includes(job.job_type) || ![undefined, "code"].includes(payload.task_mode) || payload._assess_only) return [];
  const scope = finalReviewScope(payload);
  return scope.declared ? [
    ...[...scope.files].map((path) => ({ path, lock_kind: "file" })),
    ...scope.roots.map((path) => ({ path, lock_kind: "root" })),
  ] : [{ path: "*", lock_kind: "root" }];
}

// One snapshot combines explicit prerequisites with observed and latent file
// waits. Inferred edges affect rank only: they never authorize a lease or write.
export function rankRunnableJobs(candidates, { db = getDb(), nowMs = Date.now() } = {}) {
  const jobs = db.prepare(`SELECT * FROM jobs WHERE status NOT IN (${TERMINAL_JOB_STATUSES_SQL})`).all();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const needs = new Map(jobs.map((job) => [job.id, new Set()]));
  const outgoing = new Map(jobs.map((job) => [job.id, new Map()]));
  const scopes = new Map(jobs.map((job) => [job.id, scopeRows(job)]));
  function edge(producer, consumer, kind, file = null) {
    if (producer === consumer || !byId.has(consumer)) return;
    needs.get(consumer).add(producer);
    if (!byId.has(producer)) return;
    const reasons = outgoing.get(producer).get(consumer) || [];
    if (!reasons.some((reason) => reason.kind === kind && reason.file === file)) reasons.push({ kind, file });
    outgoing.get(producer).set(consumer, reasons);
  }
  for (const dep of db.prepare(`SELECT d.* FROM job_dependencies d JOIN jobs producer ON producer.id = d.depends_on_job_id
    WHERE d.dependency_kind = 'hard' AND producer.status != 'succeeded'`).all()) {
    edge(dep.depends_on_job_id, dep.job_id, POLICY.edgeKinds.dependency);
  }
  for (const consumer of jobs) {
    for (const contract of parseJobPayload(consumer)._shared_contracts || []) {
      const owners = jobs.filter((owner) => owner.work_item_id === consumer.work_item_id
        && owner.parent_job_id === consumer.parent_job_id
        && parseJobPayload(owner)._plan_task_id === contract.owner_task_id);
      if (owners.length === 1) edge(owners[0].id, consumer.id, POLICY.edgeKinds.contract);
    }
  }
  const writers = jobs.filter((job) => ["dev", "fix", "promote"].includes(job.job_type));
  const locks = db.prepare("SELECT * FROM work_item_file_locks WHERE released_at IS NULL").all();
  const activeLocks = db.prepare("SELECT * FROM job_file_locks WHERE released_at IS NULL").all();
  function fileOwners(waiter, holderWi, path, lockKind, holderJob = null) {
    const row = { path, lock_kind: lockKind };
    if (holderJob) edge(holderJob, waiter.id, POLICY.edgeKinds.file, path);
    // Future writers reserve the same file even when an earlier writer already
    // completed. Propagating through their hard prerequisites promotes the chain.
    for (const owner of writers) {
      if (owner.work_item_id === holderWi && findLockRowOverlap(scopes.get(owner.id), [row])) {
        edge(owner.id, waiter.id, POLICY.edgeKinds.file, path);
      }
    }
  }
  for (const waiter of jobs.filter((job) => job.status === "queued")) {
    for (const lock of [...locks, ...activeLocks]) {
      if (lock.work_item_id !== waiter.work_item_id && findLockRowOverlap(scopes.get(waiter.id), [lock])) {
        fileOwners(waiter, lock.work_item_id, lock.path, lock.lock_kind, lock.job_id);
      }
    }
  }
  for (const wait of db.prepare("SELECT * FROM file_lane_waits").all()) {
    const waiter = byId.get(wait.waiter_job_id);
    if (waiter?.status === "queued") fileOwners(waiter, wait.holder_work_item_id, wait.path, wait.lock_kind, wait.holder_job_id);
  }
  return candidates.map((job) => {
    const descendants = new Set();
    const files = new Set();
    const pending = [job.id];
    while (pending.length) {
      const parent = pending.pop();
      for (const [id, reasons] of outgoing.get(parent) || []) {
        if (id === job.id) continue;
        for (const reason of reasons) if (reason.file) files.add(reason.file);
        if (descendants.has(id)) continue;
        descendants.add(id);
        pending.push(id);
      }
    }
    const direct = [...(outgoing.get(job.id)?.keys() || [])];
    const immediate = direct.filter((id) => needs.get(id).size === 1);
    const age = Math.max(0, Math.floor((nowMs - (Date.parse(job.created_at) || nowMs)) / POLICY.ageQuantumMs));
    const impact = Math.min(POLICY.maxUnlockWeight, immediate.length * 2 + descendants.size);
    const priority = (POLICY.priorities[job.priority] || 0) * POLICY.priorityWeight;
    return { ...job, _scheduling: { score: priority + age + impact, priority, age, impact,
      immediate_job_ids: immediate.sort((a, b) => a - b), downstream_job_ids: [...descendants].sort((a, b) => a - b),
      files: [...files].sort(), edges: direct.map((id) => ({ job_id: id, reasons: outgoing.get(job.id).get(id) })) } };
  }).sort(compareRunnableRank);
}

export function compareRunnableRank(a, b) {
  const kind = (job) => [true, 1, "1"].includes(parseJobPayload(job)._assess_only) ? 0 : job.job_type === "fix" ? 1 : job.job_type === "promote" ? 2 : 3;
  return (b._scheduling?.score || 0) - (a._scheduling?.score || 0)
    || kind(a) - kind(b) || a.created_at.localeCompare(b.created_at) || a.id - b.id;
}
