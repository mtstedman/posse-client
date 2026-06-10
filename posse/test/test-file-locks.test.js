import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { closeDb, getDb } from "../lib/shared/storage/functions/index.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { closeAccountSettingsDb, setAccountSettingsPathForTests } from "../lib/domains/settings/functions/account-settings.js";
import {
  addCrossWiMergeDependency,
  acquireLeaseWithWriteLocks,
  cleanupStaleFileLocks,
  createJob,
  createWorkItem,
  crossWiMergeDependencyWouldCycle,
  findWriteLockConflict,
  getEvents,
  getJob,
  getWorkItem,
  getWorkItemMergeDependencies,
  jobHasWritePermission,
  jobNeedsWriteLocks,
  listCrossWiMergeBlockers,
  listActiveFileLocks,
  requeueWorkItemAfterRejection,
  releaseLease,
  rollbackPendingCrossWiSyncHandoffsForJob,
  setMergeState,
  setSetting,
  setWorkItemBranch,
  updateJobStatus,
  updateWorkItemStatus,
  workItemCanReleaseFileLock,
} from "../lib/domains/queue/functions/index.js";
import { collectHeldQueueLocks } from "../lib/domains/scheduler/functions/held-locks.js";
import { findFileConflict, parseFileScope } from "../lib/domains/scheduler/functions/file-scope.js";
import { __testResolveWorktreeLockWaitMs } from "../lib/domains/git/functions/worktree.js";

let runtimeDir;

function resetDb() {
  closeDb();
  runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-file-locks-"));
  setRuntimePathOverridesForTests({ dbPath: path.join(runtimeDir, "orchestrator.db") });
  setAccountSettingsPathForTests(path.join(runtimeDir, "account-settings.db"));
}

function cleanupDb() {
  closeDb();
  closeAccountSettingsDb();
  setRuntimePathOverridesForTests(null);
  setAccountSettingsPathForTests(null);
  if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
  runtimeDir = null;
}

function devJob(workItemId, title, scope) {
  return createJob({
    work_item_id: workItemId,
    job_type: "dev",
    title,
    payload_json: {
      task_mode: "code",
      files_to_modify: scope.files_to_modify || [],
      files_to_create: scope.files_to_create || [],
      files_to_delete: scope.files_to_delete || [],
      create_roots: scope.create_roots || [],
    },
  });
}

function artificerJob(workItemId, title, scope) {
  return createJob({
    work_item_id: workItemId,
    job_type: "artificer",
    title,
    payload_json: {
      task_mode: scope.task_mode || "image",
      output_root: scope.output_root || ".posse/resources/artifacts/wi-test/task",
      files_to_modify: scope.files_to_modify || [],
      files_to_create: scope.files_to_create || [],
      files_to_delete: scope.files_to_delete || [],
      create_roots: scope.create_roots || [],
    },
  });
}

describe("persisted file locks", () => {
  beforeEach(() => {
    cleanupDb();
    resetDb();
  });

  after(() => {
    cleanupDb();
  });

  it("uses a bounded worktree lock wait by default while preserving explicit overrides", () => {
    assert.equal(__testResolveWorktreeLockWaitMs(), 180000);
    setSetting("worktree_lock_wait_ms", "90000");
    assert.equal(__testResolveWorktreeLockWaitMs(), 90000);
    assert.equal(__testResolveWorktreeLockWaitMs(17), 17);
  });

  it("holds inner job locks through assessment and releases them on pass", () => {
    const wi = createWorkItem("A", "desc");
    const first = devJob(wi.id, "edit shared", { files_to_modify: ["script.js"] });
    const sibling = devJob(wi.id, "edit shared sibling", { files_to_modify: ["script.js"] });

    const leaseFirst = acquireLeaseWithWriteLocks(first, "sched", 60);
    assert.ok(leaseFirst?.leaseToken);
    assert.equal(listActiveFileLocks().work_items.length, 1);
    assert.equal(listActiveFileLocks().jobs.length, 1);

    assert.equal(updateJobStatus(first.id, "awaiting_assessment", { leaseToken: leaseFirst.leaseToken }), true);
    getDb().prepare(`
      UPDATE job_file_locks
      SET released_at = NULL, release_reason = NULL
      WHERE job_id = ?
    `).run(first.id);
    assert.equal(listActiveFileLocks().work_items.length, 1);
    assert.equal(listActiveFileLocks().jobs.length, 1);
    assert.equal(acquireLeaseWithWriteLocks(getJob(sibling.id), "sched-sibling", 60), null);

    assert.equal(updateJobStatus(first.id, "succeeded", { leaseToken: leaseFirst.leaseToken }), true);
    assert.equal(listActiveFileLocks().jobs.length, 0);
    const siblingLease = acquireLeaseWithWriteLocks(getJob(sibling.id), "sched-sibling", 60);
    assert.ok(siblingLease?.leaseToken);
  });

  it("derives inner locks from active job status instead of release bookkeeping", () => {
    const wi = createWorkItem("A", "desc");
    const first = devJob(wi.id, "edit shared", { files_to_modify: ["script.js"] });
    const sibling = devJob(wi.id, "edit shared sibling", { files_to_modify: ["script.js"] });

    const leaseFirst = acquireLeaseWithWriteLocks(first, "sched", 60);
    assert.ok(leaseFirst?.leaseToken);
    getDb().prepare(`
      UPDATE job_file_locks
      SET released_at = ?, release_reason = 'test_early_release'
      WHERE job_id = ?
    `).run(new Date().toISOString(), first.id);

    const conflictWhileLeased = findWriteLockConflict(getJob(sibling.id));
    assert.equal(conflictWhileLeased?.type, "job");
    assert.equal(Number(conflictWhileLeased?.lock?.job_id), Number(first.id));

    assert.equal(updateJobStatus(first.id, "awaiting_assessment", { leaseToken: leaseFirst.leaseToken }), true);
    getDb().prepare(`
      UPDATE job_file_locks
      SET released_at = NULL, release_reason = NULL
      WHERE job_id = ?
    `).run(first.id);

    assert.equal(findWriteLockConflict(getJob(sibling.id))?.type, "job");

    assert.equal(updateJobStatus(first.id, "succeeded", { leaseToken: leaseFirst.leaseToken }), true);
    getDb().prepare(`
      UPDATE job_file_locks
      SET released_at = NULL, release_reason = NULL
      WHERE job_id = ?
    `).run(first.id);

    assert.equal(findWriteLockConflict(getJob(sibling.id)), null);
    const siblingLease = acquireLeaseWithWriteLocks(getJob(sibling.id), "sched-sibling", 60);
    assert.ok(siblingLease?.leaseToken);
  });

  it("locks queued repair scopes without treating the failed parent as active", () => {
    const wi = createWorkItem("A", "desc");
    const first = devJob(wi.id, "edit shared", { files_to_modify: ["script.js"] });
    const sibling = devJob(wi.id, "edit shared sibling", { files_to_modify: ["script.js"] });

    const leaseFirst = acquireLeaseWithWriteLocks(first, "sched", 60);
    assert.ok(leaseFirst?.leaseToken);
    assert.equal(updateJobStatus(first.id, "failed", { leaseToken: leaseFirst.leaseToken }), true);
    assert.equal(findWriteLockConflict(getJob(sibling.id)), null);

    const fix = createJob({
      work_item_id: wi.id,
      parent_job_id: first.id,
      job_type: "fix",
      title: "Fix shared",
      payload_json: {
        files_to_modify: ["script.js"],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
      },
    });

    const conflictDuringFix = findWriteLockConflict(getJob(sibling.id));
    assert.equal(conflictDuringFix?.type, "job");
    assert.equal(Number(conflictDuringFix.lock.job_id), Number(fix.id));
    assert.equal(listActiveFileLocks().jobs.some((lock) => Number(lock.job_id) === Number(first.id)), false);
    assert.equal(acquireLeaseWithWriteLocks(getJob(sibling.id), "sched-sibling", 60), null);

    assert.equal(findWriteLockConflict(getJob(fix.id)), null);
    const fixLease = acquireLeaseWithWriteLocks(getJob(fix.id), "sched-fix", 60);
    assert.ok(fixLease?.leaseToken);
    assert.equal(releaseLease(fix.id, fixLease.leaseToken, "succeeded"), true);
    assert.equal(findWriteLockConflict(getJob(sibling.id)), null);
    const siblingLease = acquireLeaseWithWriteLocks(getJob(sibling.id), "sched-sibling", 60);
    assert.ok(siblingLease?.leaseToken);
  });

  it("does not let sibling fix jobs from the same failed parent phantom-lock each other", () => {
    const wi = createWorkItem("A", "desc");
    const parent = devJob(wi.id, "edit shared", { files_to_modify: ["script.js"] });

    const parentLease = acquireLeaseWithWriteLocks(parent, "sched", 60);
    assert.ok(parentLease?.leaseToken);
    assert.equal(updateJobStatus(parent.id, "failed", { leaseToken: parentLease.leaseToken }), true);

    const fixA = createJob({
      work_item_id: wi.id,
      parent_job_id: parent.id,
      job_type: "fix",
      title: "Fix issue A",
      payload_json: { files_to_modify: ["script.js"], files_to_create: [], files_to_delete: [], create_roots: [] },
    });
    const fixB = createJob({
      work_item_id: wi.id,
      parent_job_id: parent.id,
      job_type: "fix",
      title: "Fix issue B",
      payload_json: { files_to_modify: ["script.js"], files_to_create: [], files_to_delete: [], create_roots: [] },
    });
    const fixC = createJob({
      work_item_id: wi.id,
      parent_job_id: parent.id,
      job_type: "fix",
      title: "Fix issue C",
      payload_json: { files_to_modify: ["script.js"], files_to_create: [], files_to_delete: [], create_roots: [] },
    });

    // Before the cohort allowance: every fix in the cohort would phantom-lock
    // the others, deadlocking all three. After: each reports no conflict, so
    // the scheduler is free to pick one (callers serialize via hard deps).
    assert.equal(findWriteLockConflict(getJob(fixA.id)), null);
    assert.equal(findWriteLockConflict(getJob(fixB.id)), null);
    assert.equal(findWriteLockConflict(getJob(fixC.id)), null);

    // Once a sibling actually leases, its real (non-queued) lock blocks the
    // others — the allowance only covers queued-status siblings.
    const leaseA = acquireLeaseWithWriteLocks(getJob(fixA.id), "sched-a", 60);
    assert.ok(leaseA?.leaseToken);
    assert.equal(acquireLeaseWithWriteLocks(getJob(fixB.id), "sched-b", 60), null);
    assert.equal(acquireLeaseWithWriteLocks(getJob(fixC.id), "sched-c", 60), null);
  });

  it("does not acquire write locks for assess-only requeued writer jobs", () => {
    const wi = createWorkItem("A", "desc");
    const assessOnly = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess prior commit",
      payload_json: {
        _assess_only: 1,
        task_mode: "code",
        files_to_modify: ["script.js"],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
      },
    });
    const sibling = devJob(wi.id, "edit shared sibling", { files_to_modify: ["script.js"] });

    assert.equal(jobNeedsWriteLocks(getJob(assessOnly.id)), false);
    assert.equal(findWriteLockConflict(getJob(sibling.id)), null);

    const assessLease = acquireLeaseWithWriteLocks(getJob(assessOnly.id), "sched-assess", 60);
    assert.ok(assessLease?.leaseToken);
    assert.equal(listActiveFileLocks().jobs.some((lock) => Number(lock.job_id) === Number(assessOnly.id)), false);
    assert.equal(listActiveFileLocks().work_items.some((lock) => Number(lock.source_job_id) === Number(assessOnly.id)), false);

    const siblingLease = acquireLeaseWithWriteLocks(getJob(sibling.id), "sched-sibling", 60);
    assert.ok(siblingLease?.leaseToken);
  });

  it("only allows cross-WI path release after the holder has no unresolved writer for that file", () => {
    const wi = createWorkItem("A", "desc");
    const completed = devJob(wi.id, "edit index", { files_to_modify: ["index.php"] });
    const lease = acquireLeaseWithWriteLocks(completed, "sched", 60);
    assert.ok(lease?.leaseToken);
    assert.equal(releaseLease(completed.id, lease.leaseToken, "succeeded"), true);

    assert.equal(workItemCanReleaseFileLock(wi.id, "index.php", "file").ok, true);

    const unrelated = devJob(wi.id, "edit style", { files_to_modify: ["style.css"] });
    assert.equal(workItemCanReleaseFileLock(wi.id, "index.php", "file").ok, true);

    const sameFile = devJob(wi.id, "edit index again", { files_to_modify: ["index.php"] });
    const blockedBySameFile = workItemCanReleaseFileLock(wi.id, "index.php", "file");
    assert.equal(blockedBySameFile.ok, false);
    assert.equal(blockedBySameFile.reason, "unresolved_job_scope");

    updateJobStatus(sameFile.id, "canceled");
    assert.equal(workItemCanReleaseFileLock(wi.id, "index.php", "file").ok, true);

    const rootWriter = devJob(wi.id, "edit htdocs root", { create_roots: ["htdocs"] });
    assert.equal(workItemCanReleaseFileLock(wi.id, "htdocs/index.php", "file").ok, false);
    assert.equal(workItemCanReleaseFileLock(wi.id, "htdocs", "root").ok, false);
    updateJobStatus(rootWriter.id, "canceled");
    updateJobStatus(unrelated.id, "canceled");
    assert.equal(workItemCanReleaseFileLock(wi.id, "index.php", "file").ok, true);
    assert.deepEqual(workItemCanReleaseFileLock(wi.id, "htdocs", "root"), {
      ok: true,
      blockers: [],
      reason: "idle_path",
    });
  });

  it("records one-way cross-WI merge dependencies for file handoffs", () => {
    const upstream = createWorkItem("A", "desc");
    const downstream = createWorkItem("B", "desc");
    const final = createWorkItem("C", "desc");

    const added = addCrossWiMergeDependency(downstream.id, upstream.id, {
      path: "index.php",
      source_branch: "posse/wi-a",
      via_job_id: 123,
    });
    assert.equal(added.ok, true);
    assert.equal(added.added, true);

    const deps = getWorkItemMergeDependencies(downstream.id);
    assert.equal(deps.length, 1);
    assert.equal(deps[0].source_work_item_id, upstream.id);
    assert.equal(deps[0].path, "index.php");

    const duplicate = addCrossWiMergeDependency(downstream.id, upstream.id, { path: "./index.php" });
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.added, false);

    const reverseCheck = crossWiMergeDependencyWouldCycle(upstream.id, downstream.id);
    assert.equal(reverseCheck.wouldCycle, true);
    assert.equal(reverseCheck.reason, "merge_order_cycle");

    assert.equal(addCrossWiMergeDependency(final.id, downstream.id, { path: "style.css" }).ok, true);
    const transitiveCheck = crossWiMergeDependencyWouldCycle(upstream.id, final.id);
    assert.equal(transitiveCheck.wouldCycle, true);
    assert.equal(transitiveCheck.reason, "merge_order_cycle");

    const reverseAdd = addCrossWiMergeDependency(upstream.id, downstream.id, { path: "style.css" });
    assert.equal(reverseAdd.ok, false);
    assert.equal(reverseAdd.reason, "merge_order_cycle");

    const blockers = listCrossWiMergeBlockers(downstream.id);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].source_work_item_id, upstream.id);
    assert.deepEqual(blockers[0].paths, ["index.php"]);

    setMergeState(upstream.id, "merged");
    assert.deepEqual(listCrossWiMergeBlockers(downstream.id), []);
  });

  it("keeps lock tiers separate for scheduler lookahead", () => {
    const wiA = createWorkItem("A", "desc");
    const wiB = createWorkItem("B", "desc");
    const done = devJob(wiA.id, "edit shared", { files_to_modify: ["script.js"] });
    const sameWi = devJob(wiA.id, "same WI peer", { files_to_modify: ["script.js"] });
    const otherWi = devJob(wiB.id, "other WI peer", { files_to_modify: ["script.js"] });

    const lease = acquireLeaseWithWriteLocks(done, "sched", 60);
    assert.ok(lease?.leaseToken);
    assert.equal(releaseLease(done.id, lease.leaseToken, "succeeded"), true);

    const { heldLocks } = collectHeldQueueLocks();
    assert.equal(findFileConflict(parseFileScope(sameWi), heldLocks), null);
    const externalConflict = findFileConflict(parseFileScope(otherWi), heldLocks);
    assert.equal(externalConflict?.lock?.lock_tier, "work_item");
    assert.equal(Number(externalConflict?.lock?.work_item_id), wiA.id);
  });

  it("includes delete-only scope in scheduler lookahead", () => {
    const wiA = createWorkItem("A", "desc");
    const wiB = createWorkItem("B", "desc");
    const deleterA = devJob(wiA.id, "delete shared", { files_to_delete: ["script.js"] });
    const deleterB = devJob(wiB.id, "delete shared too", { files_to_delete: ["script.js"] });

    const parsed = parseFileScope(deleterA);
    assert.deepEqual(parsed.files, ["script.js"]);
    const conflict = findFileConflict(parseFileScope(deleterB), [{
      path: "script.js",
      lock_kind: "file",
      work_item_id: wiA.id,
      job_id: deleterA.id,
    }]);
    assert.equal(conflict?.candidate?.path, "script.js");
  });

  it("removes pending cross-WI handoff dependencies when a downstream sync job dead-letters", () => {
    const upstream = createWorkItem("A", "desc");
    const downstream = createWorkItem("B", "desc");
    const job = devJob(downstream.id, "sync then edit", {
      files_to_modify: ["index.php"],
    });
    const payload = JSON.parse(job.payload_json);
    payload._cross_wi_file_syncs = [{
      path: "index.php",
      source_work_item_id: upstream.id,
      source_branch: "posse/wi-a",
    }];
    getDb().prepare(`UPDATE jobs SET payload_json = ? WHERE id = ?`).run(JSON.stringify(payload), job.id);

    const dep = addCrossWiMergeDependency(downstream.id, upstream.id, {
      path: "index.php",
      source_branch: "posse/wi-a",
      via_job_id: job.id,
    });
    assert.equal(dep.ok, true);
    assert.equal(getWorkItemMergeDependencies(downstream.id).length, 1);

    const lease = acquireLeaseWithWriteLocks(getJob(job.id), "sched", 60);
    assert.ok(lease?.leaseToken);
    assert.equal(releaseLease(job.id, lease.leaseToken, "dead_letter"), true);

    assert.deepEqual(getWorkItemMergeDependencies(downstream.id), []);
    const rolledBack = JSON.parse(getJob(job.id).payload_json)._cross_wi_file_syncs_rolled_back;
    assert.equal(Array.isArray(rolledBack), true);
    assert.equal(rolledBack[0].path, "index.php");
  });

  it("does not strand downstream merges on canceled or hard-failed upstream work items", () => {
    const canceled = createWorkItem("Canceled source", "desc");
    const failed = createWorkItem("Failed source", "desc");
    const downstream = createWorkItem("Downstream", "desc");

    assert.equal(addCrossWiMergeDependency(downstream.id, canceled.id, { path: "a.php" }).ok, true);
    assert.equal(addCrossWiMergeDependency(downstream.id, failed.id, { path: "b.php" }).ok, true);
    updateWorkItemStatus(canceled.id, "canceled");
    updateWorkItemStatus(failed.id, "failed");

    assert.deepEqual(listCrossWiMergeBlockers(downstream.id), []);
  });

  it("clears cross-WI merge dependency metadata once the downstream WI merges", () => {
    const upstream = createWorkItem("Source", "desc");
    const downstream = createWorkItem("Downstream", "desc");
    assert.equal(addCrossWiMergeDependency(downstream.id, upstream.id, { path: "index.php" }).ok, true);
    assert.equal(getWorkItemMergeDependencies(downstream.id).length, 1);

    setMergeState(downstream.id, "merged");
    assert.deepEqual(getWorkItemMergeDependencies(downstream.id), []);
  });

  it("clears cross-WI merge dependencies when a downstream WI is failed, canceled, or requeued", () => {
    const upstream = createWorkItem("Source", "desc");
    const failed = createWorkItem("Failed downstream", "desc");
    const canceled = createWorkItem("Canceled downstream", "desc");
    const requeued = createWorkItem("Requeued downstream", "desc");

    assert.equal(addCrossWiMergeDependency(failed.id, upstream.id, { path: "failed.php" }).ok, true);
    assert.equal(addCrossWiMergeDependency(canceled.id, upstream.id, { path: "canceled.php" }).ok, true);
    assert.equal(addCrossWiMergeDependency(requeued.id, upstream.id, { path: "requeued.php" }).ok, true);

    updateWorkItemStatus(failed.id, "failed");
    updateWorkItemStatus(canceled.id, "canceled");
    requeueWorkItemAfterRejection(requeued.id);

    assert.deepEqual(getWorkItemMergeDependencies(failed.id), []);
    assert.deepEqual(getWorkItemMergeDependencies(canceled.id), []);
    assert.deepEqual(getWorkItemMergeDependencies(requeued.id), []);
  });

  it("ignores malformed cross-WI sync rollback entries without source branches", () => {
    const upstream = createWorkItem("Source", "desc");
    const downstream = createWorkItem("Downstream", "desc");
    const job = devJob(downstream.id, "malformed sync", {
      files_to_modify: ["index.php"],
    });
    const payload = JSON.parse(job.payload_json);
    payload._cross_wi_file_syncs = [{
      path: "index.php",
      source_work_item_id: upstream.id,
    }];
    getDb().prepare(`UPDATE jobs SET payload_json = ? WHERE id = ?`).run(JSON.stringify(payload), job.id);
    assert.equal(addCrossWiMergeDependency(downstream.id, upstream.id, { path: "index.php" }).ok, true);

    const result = rollbackPendingCrossWiSyncHandoffsForJob(job, "test_malformed");

    assert.equal(result.rolled_back, 0);
    assert.equal(getWorkItemMergeDependencies(downstream.id).length, 1);
    assert.equal(getEvents(job.id, 20).some((event) => event.event_type === "work_item.cross_wi_file_handoff_rolled_back"), false);
  });

  it("keeps pending cross-WI sync rollback idempotent for stale job objects", () => {
    const upstream = createWorkItem("Source", "desc");
    const downstream = createWorkItem("Downstream", "desc");
    const job = devJob(downstream.id, "valid sync", {
      files_to_modify: ["index.php"],
    });
    const payload = JSON.parse(job.payload_json);
    payload._cross_wi_file_syncs = [{
      path: "index.php",
      source_work_item_id: upstream.id,
      source_branch: "posse/wi-source",
    }];
    getDb().prepare(`UPDATE jobs SET payload_json = ? WHERE id = ?`).run(JSON.stringify(payload), job.id);
    assert.equal(addCrossWiMergeDependency(downstream.id, upstream.id, { path: "index.php" }).ok, true);

    const staleJob = getJob(job.id);
    assert.equal(rollbackPendingCrossWiSyncHandoffsForJob(staleJob, "test_idempotent").rolled_back, 1);
    assert.equal(rollbackPendingCrossWiSyncHandoffsForJob(staleJob, "test_idempotent").rolled_back, 0);

    const rollbackEvents = getEvents(job.id, 20)
      .filter((event) => event.event_type === "work_item.cross_wi_file_handoff_rolled_back");
    assert.equal(rollbackEvents.length, 1);
    assert.deepEqual(getWorkItemMergeDependencies(downstream.id), []);
  });

  it("retains WI locks after source job success until the work item merges", () => {
    const wiA = createWorkItem("A", "desc");
    const wiB = createWorkItem("B", "desc");
    const a = devJob(wiA.id, "edit shared", { files_to_modify: ["script.js"] });
    const b = devJob(wiB.id, "edit shared too", { files_to_modify: ["script.js"] });

    const leaseA = acquireLeaseWithWriteLocks(a, "sched", 60);
    assert.ok(leaseA?.leaseToken);
    assert.equal(listActiveFileLocks().work_items.length, 1);
    assert.equal(listActiveFileLocks().jobs.length, 1);

    assert.equal(releaseLease(a.id, leaseA.leaseToken, "succeeded"), true);
    assert.equal(listActiveFileLocks().jobs.length, 0);
    assert.equal(listActiveFileLocks().work_items.length, 1);
    assert.equal(acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60), null);

    setWorkItemBranch(wiA.id, "posse/wi-lock-retained", "base");
    updateWorkItemStatus(wiA.id, "complete");
    assert.equal(listActiveFileLocks().work_items.length, 1);
    assert.equal(acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60), null);

    setMergeState(wiA.id, "merged");
    assert.equal(listActiveFileLocks().work_items.length, 0);

    const leaseB = acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60);
    assert.ok(leaseB?.leaseToken);
  });

  it("records one persistent write-lock notice instead of spamming identical events", () => {
    const wiA = createWorkItem("A", "desc");
    const wiB = createWorkItem("B", "desc");
    const a = devJob(wiA.id, "edit shared", { files_to_modify: ["script.js"] });
    const b = devJob(wiB.id, "edit shared too", { files_to_modify: ["script.js"] });

    const leaseA = acquireLeaseWithWriteLocks(a, "sched", 60);
    assert.ok(leaseA?.leaseToken);

    assert.equal(acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60), null);
    assert.equal(acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60), null);
    assert.equal(acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60), null);

    const blockedEvents = getEvents(b.id, 20).filter((event) => event.event_type === "job.write_lock_blocked");
    assert.equal(blockedEvents.length, 1);
    const meta = JSON.parse(blockedEvents[0].event_json);
    assert.equal(meta.visible, false);
    assert.equal(meta.persistent_notice, true);
  });

  it("does not create persistent WI locks for jobs leased after their WI is merged", () => {
    const wi = createWorkItem("Already merged", "desc");
    getDb().prepare(`
      UPDATE work_items
      SET status = 'complete', branch_name = 'posse/wi-already-merged', merge_state = 'merged'
      WHERE id = ?
    `).run(wi.id);

    const late = devJob(wi.id, "late retry", { files_to_modify: ["script.js"] });
    const lease = acquireLeaseWithWriteLocks(late, "sched", 60);
    assert.ok(lease?.leaseToken);

    const locks = listActiveFileLocks();
    assert.equal(locks.work_items.some((lock) => lock.work_item_id === wi.id), false);
    assert.equal(locks.jobs.some((lock) => lock.job_id === late.id), true);
  });

  it("cleanup preserves completed WI locks while the branch awaits merge", () => {
    const wiA = createWorkItem("A", "desc");
    const wiB = createWorkItem("B", "desc");
    const a = devJob(wiA.id, "edit shared", { files_to_modify: ["script.js"] });
    const b = devJob(wiB.id, "edit shared too", { files_to_modify: ["script.js"] });

    const leaseA = acquireLeaseWithWriteLocks(a, "sched", 60);
    assert.ok(leaseA?.leaseToken);
    assert.equal(releaseLease(a.id, leaseA.leaseToken, "succeeded"), true);
    setWorkItemBranch(wiA.id, "posse/wi-pending-review-lock", "base");
    updateWorkItemStatus(wiA.id, "complete");
    assert.equal(listActiveFileLocks().work_items.some((lock) => lock.work_item_id === wiA.id), true);

    const cleaned = cleanupStaleFileLocks();
    assert.equal(cleaned.wi_locks_released, 0);
    assert.equal(acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60), null);

    setMergeState(wiA.id, "merged");
    const leaseB = acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60);
    assert.ok(leaseB?.leaseToken);
  });

  it("marks completed branch WIs pending review before retaining file locks", () => {
    const wi = createWorkItem("Explicit review lock lifecycle", "desc");
    const job = devJob(wi.id, "edit shared", { files_to_modify: ["script.js"] });

    const lease = acquireLeaseWithWriteLocks(job, "sched", 60);
    assert.ok(lease?.leaseToken);
    assert.equal(releaseLease(job.id, lease.leaseToken, "succeeded"), true);
    setWorkItemBranch(wi.id, "posse/wi-explicit-review-lock", "base");
    updateWorkItemStatus(wi.id, "complete");

    assert.equal(getWorkItem(wi.id).merge_state, "pending_review");
    assert.equal(listActiveFileLocks().work_items.some((lock) => lock.work_item_id === wi.id), true);
  });

  it("sweeps completed branch locks when merge state was never marked for review", () => {
    const wi = createWorkItem("Abandoned complete branch lock", "desc");
    const job = devJob(wi.id, "edit shared", { files_to_modify: ["script.js"] });

    const lease = acquireLeaseWithWriteLocks(job, "sched", 60);
    assert.ok(lease?.leaseToken);
    assert.equal(releaseLease(job.id, lease.leaseToken, "succeeded"), true);
    setWorkItemBranch(wi.id, "posse/wi-abandoned-complete-lock", "base");
    updateWorkItemStatus(wi.id, "complete");
    getDb().prepare(`UPDATE work_items SET merge_state = NULL WHERE id = ?`).run(wi.id);

    assert.equal(listActiveFileLocks().work_items.some((lock) => lock.work_item_id === wi.id), false);
    const cleaned = cleanupStaleFileLocks();
    assert.equal(cleaned.wi_locks_released, 1);
  });

  it("uses job locks to block sibling jobs in the same WI while one is active", () => {
    const wi = createWorkItem("Same WI", "desc");
    const first = devJob(wi.id, "first", { files_to_modify: ["styles.css"] });
    const second = devJob(wi.id, "second", { files_to_modify: ["styles.css"] });

    const leaseFirst = acquireLeaseWithWriteLocks(first, "sched", 60);
    assert.ok(leaseFirst?.leaseToken);
    assert.equal(acquireLeaseWithWriteLocks(getJob(second.id), "sched", 60), null);

    assert.equal(releaseLease(first.id, leaseFirst.leaseToken, "succeeded"), true);
    const leaseSecond = acquireLeaseWithWriteLocks(getJob(second.id), "sched", 60);
    assert.ok(leaseSecond?.leaseToken);
  });

  it("normalizes object-shaped file entries before taking inner job locks", () => {
    const wi = createWorkItem("Object scopes", "desc");
    const first = devJob(wi.id, "first", { files_to_modify: [{ path: "src/a.js" }] });
    const second = devJob(wi.id, "second", { files_to_modify: [{ path: "src/b.js" }] });
    const overlap = devJob(wi.id, "overlap", { files_to_modify: [{ path: "src/a.js" }] });

    const firstLease = acquireLeaseWithWriteLocks(first, "sched-a", 60);
    assert.ok(firstLease?.leaseToken);
    assert.equal(findWriteLockConflict(getJob(second.id)), null);

    const secondLease = acquireLeaseWithWriteLocks(getJob(second.id), "sched-b", 60);
    assert.ok(secondLease?.leaseToken);

    const jobLockPaths = listActiveFileLocks().jobs.map((lock) => lock.path).sort();
    assert.ok(jobLockPaths.includes("src/a.js"));
    assert.ok(jobLockPaths.includes("src/b.js"));
    assert.equal(jobLockPaths.includes("[object object]"), false);

    const conflict = findWriteLockConflict(getJob(overlap.id));
    assert.equal(conflict?.type, "job");
    assert.equal(conflict.lock.path, "src/a.js");
  });

  it("does not lock read-only jobs", () => {
    const wi = createWorkItem("Research", "desc");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "read",
      payload_json: { files_to_modify: ["script.js"] },
    });

    const lease = acquireLeaseWithWriteLocks(job, "sched", 60);
    assert.ok(lease?.leaseToken);
    assert.deepEqual(listActiveFileLocks(), { work_items: [], jobs: [] });
  });

  it("does not create queue locks for artificer artifact jobs", () => {
    const wiA = createWorkItem("Artifact A", "desc");
    const wiB = createWorkItem("Artifact B", "desc");
    const a = artificerJob(wiA.id, "generate image a", {
      output_root: ".posse/resources/artifacts/wi-a/task-01",
      create_roots: [".posse/resources/artifacts/wi-a/task-01"],
      files_to_create: [".posse/resources/artifacts/wi-a/task-01/decor-brief.png"],
    });
    const b = artificerJob(wiB.id, "generate image b", {
      output_root: ".posse/resources/artifacts/wi-b/task-01",
      create_roots: [".posse/resources/artifacts/wi-b/task-01"],
      files_to_create: [".posse/resources/artifacts/wi-b/task-01/decor-brief.png"],
    });

    assert.equal(jobHasWritePermission(a), true);
    assert.equal(jobNeedsWriteLocks(a), false);
    assert.equal(findWriteLockConflict(a), null);

    const leaseA = acquireLeaseWithWriteLocks(a, "sched-a", 60);
    assert.ok(leaseA?.leaseToken);
    assert.deepEqual(listActiveFileLocks(), { work_items: [], jobs: [] });

    const leaseB = acquireLeaseWithWriteLocks(getJob(b.id), "sched-b", 60);
    assert.ok(leaseB?.leaseToken);
    assert.deepEqual(listActiveFileLocks(), { work_items: [], jobs: [] });
  });

  it("ignores legacy artificer lock rows when checking repo write conflicts", () => {
    const db = getDb();
    const wiA = createWorkItem("Legacy artifact lock", "desc");
    const wiB = createWorkItem("Repo edit", "desc");
    const artifact = artificerJob(wiA.id, "old artifact lock source", {
      files_to_create: ["shared.png"],
      create_roots: ["."],
    });
    db.prepare(`
      INSERT INTO work_item_file_locks (work_item_id, path, lock_kind, source_job_id, acquired_at, metadata_json)
      VALUES (?, ?, 'file', ?, ?, ?)
    `).run(wiA.id, "shared.png", artifact.id, new Date().toISOString(), JSON.stringify({ source: "legacy_test" }));
    db.prepare(`
      INSERT INTO job_file_locks (job_id, work_item_id, path, lock_kind, acquired_at, metadata_json)
      VALUES (?, ?, ?, 'file', ?, ?)
    `).run(artifact.id, wiA.id, "shared.png", new Date().toISOString(), JSON.stringify({ source: "legacy_test" }));

    const repoEdit = devJob(wiB.id, "edit same path", { files_to_modify: ["shared.png"] });
    assert.equal(findWriteLockConflict(repoEdit), null);

    const lease = acquireLeaseWithWriteLocks(repoEdit, "sched", 60);
    assert.ok(lease?.leaseToken);
  });

  it("treats files_to_delete as write scope", () => {
    const wiA = createWorkItem("A", "desc");
    const wiB = createWorkItem("B", "desc");
    const a = devJob(wiA.id, "edit shared", { files_to_modify: ["script.js"] });
    const b = devJob(wiB.id, "delete shared", { files_to_delete: ["script.js"] });

    const leaseA = acquireLeaseWithWriteLocks(a, "sched", 60);
    assert.ok(leaseA?.leaseToken);
    assert.equal(acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60), null);
    assert.equal(releaseLease(a.id, leaseA.leaseToken, "succeeded"), true);
    updateWorkItemStatus(wiA.id, "complete");

    const leaseB = acquireLeaseWithWriteLocks(getJob(b.id), "sched", 60);
    assert.ok(leaseB?.leaseToken);
  });

  it("uses a wildcard lock for mutating jobs with omitted scope", () => {
    const wiA = createWorkItem("A", "desc");
    const wiB = createWorkItem("B", "desc");
    const scoped = devJob(wiA.id, "edit shared", { files_to_modify: ["script.js"] });
    const unknown = devJob(wiB.id, "unknown edit scope", {});

    const leaseA = acquireLeaseWithWriteLocks(scoped, "sched", 60);
    assert.ok(leaseA?.leaseToken);
    assert.equal(acquireLeaseWithWriteLocks(getJob(unknown.id), "sched", 60), null);
    assert.equal(releaseLease(scoped.id, leaseA.leaseToken, "succeeded"), true);
    updateWorkItemStatus(wiA.id, "complete");

    const leaseUnknown = acquireLeaseWithWriteLocks(getJob(unknown.id), "sched", 60);
    assert.ok(leaseUnknown?.leaseToken);
    const locks = listActiveFileLocks();
    assert.ok(locks.jobs.some((lock) => lock.job_id === unknown.id && lock.path === "*" && lock.lock_kind === "root"));
    assert.ok(locks.work_items.some((lock) => lock.work_item_id === wiB.id && lock.path === "*" && lock.lock_kind === "root"));
  });
});
