import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  createWI,
  resetRuntimeDb,
  runtimeModules,
} from "./core/support/core-harness.js";
import {
  finalizePrepTrace,
  startPrepTrace,
  withPhase,
} from "../lib/domains/worker/functions/helpers/prep-telemetry.js";

describe("worker setup telemetry", () => {
  it("emits phase start, phase finish, and summary events", async () => {
    resetRuntimeDb();
    const db = runtimeModules.dbMod.getDb();
    const wi = createWI(db, "Telemetry WI");
    const job = createJob(db, wi.id, { job_type: "dev", title: "Telemetry job" });
    const seen = [];
    const ctx = startPrepTrace({
      workItemId: wi.id,
      jobId: job.id,
      leaseAcquiredAtMs: Date.now() - 5,
      onPhase: (event) => seen.push(event),
    });

    const value = await withPhase("worktree_add", ctx, async () => "ok");
    const summary = finalizePrepTrace(ctx, { ok: true });
    const events = runtimeModules.queueMod.getEvents(job.id, 10);

    assert.equal(value, "ok");
    assert.equal(summary.ok, true);
    assert.ok(seen.some((event) => event.state === "started" && event.phase === "worktree_add"));
    assert.ok(seen.some((event) => event.state === "finished" && event.ok === true));
    assert.ok(events.some((event) => event.event_type === "worker.setup.phase_started"));
    assert.ok(events.some((event) => event.event_type === "worker.setup.phase_finished"));
    assert.ok(events.some((event) => event.event_type === "worker.setup.summary"));
  });

  it("preserves thrown Error objects while recording failed phases", async () => {
    resetRuntimeDb();
    const db = runtimeModules.dbMod.getDb();
    const wi = createWI(db, "Telemetry failure WI");
    const job = createJob(db, wi.id, { job_type: "dev", title: "Telemetry failure job" });
    const ctx = startPrepTrace({ workItemId: wi.id, jobId: job.id });
    const original = new Error("boom");

    await assert.rejects(
      withPhase("target_merge", ctx, async () => { throw original; }),
      (err) => err === original,
    );

    const events = runtimeModules.queueMod.getEvents(job.id, 10);
    const failed = events.find((event) => event.event_type === "worker.setup.phase_finished");
    assert.ok(failed);
    assert.match(failed.event_json, /"ok":false/);
    assert.match(failed.event_json, /"error":"boom"/);
  });
});
