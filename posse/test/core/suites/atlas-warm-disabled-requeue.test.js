// A runtime-disabled ATLAS (disableAtlasForRun) is transient — the in-memory
// flag clears at the next boot — so leased atlas_warm jobs must be released
// back to the queue (with a readyAt backoff), NOT consumed as no-op
// "succeeded" stubs. The jobs hit by this path are often the self-repair
// warms the disable path itself just enqueued; consuming them would silently
// destroy the queued repair work the wrap-up message promises to leave for
// the next boot.

import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  resetRuntimeDb,
} from "../support/core-harness.js";

function makeWorkerStub(repoRoot, queueMod) {
  return {
    repoRoot,
    emit: () => {},
    _throwIfKilled: () => {},
    _releaseWithoutAttemptPenalty(job, leaseToken, finalStatus, { readyAt = null } = {}) {
      const released = queueMod.releaseLeaseWithoutAttemptPenalty(job.id, leaseToken, finalStatus, { readyAt });
      if (released) job.status = finalStatus;
      return released;
    },
    _releaseLease(job, leaseToken, finalStatus, { readyAt = null } = {}) {
      const released = queueMod.releaseLease(job.id, leaseToken, finalStatus, { readyAt });
      if (released) job.status = finalStatus;
      return released;
    },
    _retryOrFail() {},
  };
}

suite("ATLAS warm job under runtime disable", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("leaves a runtime-disabled warm job queued with a future readyAt instead of consuming it", async () => {
    const { queueMod } = runtimeModules;
    const atlasConfigMod = await import("../../../lib/domains/integrations/functions/atlas/config.js");
    const { runAtlasWarmJob } = await import("../../../lib/domains/worker/functions/execution/atlas-warm-job.js");

    const repoRoot = process.cwd();
    atlasConfigMod.__resetAtlasRuntimeDisabledForTests();
    atlasConfigMod.disableAtlasForRun("boot_background_failed: test", repoRoot);

    try {
      const wi = queueMod.createWorkItem("Disabled warm requeue", "desc");
      const job = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "atlas_warm",
        title: "ATLAS warm (main-full)",
        payload_json: JSON.stringify({ purpose: "main-full", reason: "self_repair" }),
      });
      const lease = queueMod.acquireLease(job.id, "test-worker", 900);
      assert.ok(lease?.leaseToken);

      const before = Date.now();
      await runAtlasWarmJob(makeWorkerStub(repoRoot, queueMod), queueMod.getJob(job.id), null, {
        leaseToken: lease.leaseToken,
      });

      const after = queueMod.getJob(job.id);
      assert.equal(after.status, "queued", "runtime-disabled warm must stay queued for the next boot");
      assert.equal(after.lease_token, null, "lease must be released");
      const readyAtMs = new Date(after.ready_at).getTime();
      assert.ok(
        readyAtMs > before + 60_000,
        `readyAt must be backed off into the future so the scheduler does not hot-loop the lease (got ${after.ready_at})`,
      );
      assert.equal(after.result_json ?? null, null, "no stub result may be recorded for a deferred warm");
    } finally {
      atlasConfigMod.__resetAtlasRuntimeDisabledForTests();
    }
  });

  it("repo-scoped disable for another repo does not defer this repo's warm jobs", async () => {
    const { queueMod } = runtimeModules;
    const atlasConfigMod = await import("../../../lib/domains/integrations/functions/atlas/config.js");

    atlasConfigMod.__resetAtlasRuntimeDisabledForTests();
    atlasConfigMod.disableAtlasForRun("boot_background_failed: other repo", "C:/some/other/repo");

    try {
      // The disabled-reason probe is what gates the defer; for an unrelated
      // repo key it must come back null so the job proceeds to a real warm.
      assert.equal(atlasConfigMod.getAtlasRuntimeDisabledReason(process.cwd()), null);
      assert.equal(atlasConfigMod.getAtlasRuntimeDisabledReason(), null, "no global entry may be set by a repo-scoped disable");
      void queueMod;
    } finally {
      atlasConfigMod.__resetAtlasRuntimeDisabledForTests();
    }
  });
});
