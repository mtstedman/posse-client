import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let queueMod;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

function makeGitRepo(prefix) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: repoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(repoDir, "tracked.txt"), "base\n", "utf-8");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoDir, stdio: "ignore" });
  return repoDir;
}

describe("stateful subsystem baseline", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-stateful-baseline-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    resetRuntimeDb();
  });

  beforeEach(() => {
    queueMod.__testSetLeaseClockForTests(null);
    resetRuntimeDb();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    setRuntimePathOverridesForTests(null);
  });

  it("serializes unscoped mutating jobs across work items with wildcard locks", () => {
    const wiA = queueMod.createWorkItem("Wildcard lock A", "desc");
    const wiB = queueMod.createWorkItem("Wildcard lock B", "desc");
    const jobA = queueMod.createJob({
      work_item_id: wiA.id,
      job_type: "dev",
      title: "Unscoped writer A",
    });
    const jobB = queueMod.createJob({
      work_item_id: wiB.id,
      job_type: "dev",
      title: "Unscoped writer B",
    });

    assert.deepEqual(queueMod.getJobWriteScope(jobA), { files: [], roots: ["*"], unknown: true });
    const leaseA = queueMod.acquireLeaseWithWriteLocks(jobA, "worker-a", 60);
    assert.ok(leaseA?.leaseToken);

    const conflict = queueMod.findWriteLockConflict(jobB);
    assert.equal(conflict?.type, "work_item");
    assert.equal(conflict.lock.work_item_id, wiA.id);
    assert.equal(conflict.lock.path, "*");

    const leaseB = queueMod.acquireLeaseWithWriteLocks(jobB, "worker-b", 60);
    assert.equal(leaseB, null);
    assert.equal(queueMod.getJob(jobB.id).status, "queued");
  });

  it("keeps lease CAS valid across renew-then-release and rejects stale release after requeue", () => {
    const wi = queueMod.createWorkItem("Lease CAS baseline", "desc");
    const renewedJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Renewed job",
    });
    const renewedLease = queueMod.acquireLease(renewedJob.id, "worker-renew", 60);
    assert.ok(renewedLease?.leaseToken);
    assert.equal(queueMod.renewLease(renewedJob.id, renewedLease.leaseToken, 120), true);
    assert.equal(queueMod.releaseLease(renewedJob.id, renewedLease.leaseToken, "succeeded"), true);
    assert.equal(queueMod.getJob(renewedJob.id).status, "succeeded");

    const boundaryJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Boundary renew",
    });
    const boundaryLease = queueMod.acquireLease(boundaryJob.id, "worker-boundary", 60);
    assert.ok(boundaryLease?.leaseToken);
    dbMod.getDb()
      .prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 100).toISOString(), boundaryJob.id);
    assert.equal(queueMod.renewLease(boundaryJob.id, boundaryLease.leaseToken, 120), true);
    assert.equal(queueMod.releaseLease(boundaryJob.id, boundaryLease.leaseToken, "succeeded"), true);

    const expiredJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Expired job",
    });
    const expiredLease = queueMod.acquireLease(expiredJob.id, "worker-expired", 60);
    assert.ok(expiredLease?.leaseToken);
    dbMod.getDb()
      .prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", expiredJob.id);

    assert.equal(queueMod.requeueExpiredLeases(), 1);
    assert.equal(queueMod.releaseLease(expiredJob.id, expiredLease.leaseToken, "succeeded"), false);
    const refreshed = queueMod.getJob(expiredJob.id);
    assert.equal(refreshed.status, "queued");
    assert.equal(refreshed.lease_token, null);
  });

  it("does not shorten renewed leases after a backward wall-clock jump", () => {
    let wallMs = Date.parse("2026-01-01T00:00:00.000Z");
    let monotonicMs = 0;
    queueMod.__testSetLeaseClockForTests({
      wallNowMs: () => wallMs,
      monotonicNowMs: () => monotonicMs,
    });

    try {
      const wi = queueMod.createWorkItem("Lease clock skew", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Clock-skewed job",
      });
      const lease = queueMod.acquireLease(job.id, "worker-clock", 60);
      assert.ok(lease?.leaseToken);
      const initialExpiry = Date.parse(queueMod.getJob(job.id).lease_expires_at);

      wallMs += 30_000;
      monotonicMs += 30_000;
      assert.equal(queueMod.renewLease(job.id, lease.leaseToken, 60), true);
      const extendedExpiry = Date.parse(queueMod.getJob(job.id).lease_expires_at);
      assert.equal(extendedExpiry, initialExpiry + 30_000);

      wallMs -= 120_000;
      monotonicMs += 30_000;
      assert.equal(queueMod.renewLease(job.id, lease.leaseToken, 60), true);
      const skewedExpiry = Date.parse(queueMod.getJob(job.id).lease_expires_at);
      assert.ok(skewedExpiry >= extendedExpiry);
    } finally {
      queueMod.__testSetLeaseClockForTests(null);
    }
  });

  it("uses the lease clock for write-lock lease acquisition", () => {
    let wallMs = Date.parse("2035-06-01T12:00:00.000Z");
    let monotonicMs = 0;
    queueMod.__testSetLeaseClockForTests({
      wallNowMs: () => wallMs,
      monotonicNowMs: () => monotonicMs,
    });

    try {
      const wi = queueMod.createWorkItem("Write-lock lease clock", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Clocked write-lock job",
        payload_json: {
          task_mode: "code",
          files_to_modify: ["src/clocked.js"],
        },
      });

      const lease = queueMod.acquireLeaseWithWriteLocks(job, "worker-clocked-lock", 60);
      assert.ok(lease?.leaseToken);
      const expiresAt = Date.parse(queueMod.getJob(job.id).lease_expires_at);
      assert.equal(expiresAt, wallMs + 60_000);

      wallMs -= 5 * 60_000;
      monotonicMs += 10_000;
      assert.equal(queueMod.requeueExpiredLeases(), 0);
      assert.equal(queueMod.getJob(job.id).status, "leased");
    } finally {
      queueMod.__testSetLeaseClockForTests(null);
    }
  });

  it("uses the lease clock for non-force orphan requeue decisions", () => {
    let wallMs = Date.parse("2035-06-01T12:00:00.000Z");
    let monotonicMs = 0;
    queueMod.__testSetLeaseClockForTests({
      wallNowMs: () => wallMs,
      monotonicNowMs: () => monotonicMs,
    });

    try {
      const wi = queueMod.createWorkItem("Orphan lease clock", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "dev",
        title: "Clocked orphan job",
      });
      const lease = queueMod.acquireLease(job.id, "worker-orphan-clock", 60);
      assert.ok(lease?.leaseToken);

      wallMs -= 5 * 60_000;
      monotonicMs += 70_000;
      assert.equal(queueMod.requeueOrphanedJobs(), 1);
      const refreshed = queueMod.getJob(job.id);
      assert.equal(refreshed.status, "queued");
      assert.equal(refreshed.lease_token, null);
    } finally {
      queueMod.__testSetLeaseClockForTests(null);
    }
  });

  it("derives promote wildcard mapping roots and conflicts with wildcard roots", () => {
    const wiPromote = queueMod.createWorkItem("Promote wildcard", "desc");
    const wiWildcard = queueMod.createWorkItem("Wildcard holder", "desc");
    const promoteJob = queueMod.createJob({
      work_item_id: wiPromote.id,
      job_type: "promote",
      title: "Promote pngs",
      payload_json: JSON.stringify({
        mappings: [{ pattern: "*.png", dest: "assets" }],
      }),
    });
    const wildcardJob = queueMod.createJob({
      work_item_id: wiWildcard.id,
      job_type: "dev",
      title: "Unscoped writer",
    });

    assert.deepEqual(queueMod.getJobWriteScope(promoteJob), {
      files: [],
      roots: ["assets"],
    });
    assert.ok(queueMod.acquireLeaseWithWriteLocks(wildcardJob, "worker-wildcard", 60)?.leaseToken);

    const conflict = queueMod.findWriteLockConflict(promoteJob);
    assert.equal(conflict?.type, "work_item");
    assert.equal(conflict.lock.path, "*");
    assert.equal(conflict.candidate.path, "assets");
  });

  it("copies visible files before replacing a worktree with corrupt git metadata", async () => {
    const { gitWorktreeAdd, worktreeRoot } = await import("../lib/domains/git/functions/worktree.js");
    const projectDir = makeGitRepo("posse-corrupt-worktree-");
    try {
      const wtPath = path.join(worktreeRoot(projectDir), "wi-77-corrupt");
      fs.mkdirSync(path.join(wtPath, "nested"), { recursive: true });
      fs.writeFileSync(path.join(wtPath, ".git"), "not a valid gitfile\n", "utf-8");
      fs.writeFileSync(path.join(wtPath, "nested", "notes.txt"), "keep me\n", "utf-8");

      const snapshots = [];
      const branchName = "posse/wi-77-corrupt";
      gitWorktreeAdd(wtPath, branchName, projectDir, {
        wiId: 77,
        onDirtySnapshot: (snapshotPath, message = "") => snapshots.push({ snapshotPath, message }),
      });

      const recovery = snapshots.find((entry) => /corrupt-metadata/.test(entry.message));
      assert.ok(recovery?.snapshotPath);
      assert.equal(
        fs.readFileSync(path.join(recovery.snapshotPath, "nested", "notes.txt"), "utf-8"),
        "keep me\n",
      );
      assert.equal(fs.existsSync(path.join(recovery.snapshotPath, ".git")), false);
      const info = JSON.parse(fs.readFileSync(path.join(recovery.snapshotPath, ".posse-recovery-info.json"), "utf-8"));
      assert.equal(info.reason, "git_metadata_corrupt");
      assert.equal(info.work_item_id, 77);
      assert.equal(
        execFileSync("git", ["branch", "--show-current"], { cwd: wtPath, encoding: "utf-8" }).trim(),
        branchName,
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
