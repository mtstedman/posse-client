import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let dbMod;
let queueMod;
let fanoutMod;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

describe("fanout child timeout sweep", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-fanout-timeout-"));
    runtimeDbPath = path.join(runtimeDir, ".posse", "db", "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    fanoutMod = await import("../lib/domains/research/functions/fanout.js");
    resetRuntimeDb();
  });

  beforeEach(() => {
    resetRuntimeDb();
    fanoutMod.__resetFanoutTimeoutSweepForTests();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    setRuntimePathOverridesForTests(null);
  });

  function createFanoutChild({ wi, label, index, runId = "fanout-test" }) {
    return queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: `Research (${label}): ${wi.title}`,
      payload_json: JSON.stringify({
        role_mode: "child",
        fanout_mode: "active",
        fanout_run_id: runId,
        fanout_branch_index: index,
        fanout_branch: { label, kind: "module", scope_hints: [] },
      }),
    });
  }

  // Simulate a child that actually ran and fell back to queued: the running
  // transition stamps started_at, which the sweep requires so never-leased
  // children waiting out queue saturation are not falsely expired.
  function markStartedAndRequeued(jobId) {
    queueMod.updateJobStatus(jobId, "running");
    queueMod.updateJobStatus(jobId, "queued");
  }

  it("marks started-then-requeued fanout children past timeout as succeeded with a synthetic artifact", () => {
    const wi = queueMod.createWorkItem("Audit X", "look into X");
    const stuck = createFanoutChild({ wi, label: "alpha", index: 0 });
    const fresh = createFanoutChild({ wi, label: "beta", index: 1 });
    markStartedAndRequeued(stuck.id);
    markStartedAndRequeued(fresh.id);

    // Sweep with nowMs far in the future so the timeout cutoff lands past both
    // children's started_at.
    const futureMs = Date.now() + 60 * 60 * 1000; // +1h
    const result = fanoutMod.expireStuckFanoutChildren({ timeoutSec: 60, nowMs: futureMs });

    assert.equal(result.expired, 2, "both started-then-requeued children should expire");
    const refetchedStuck = queueMod.getJob(stuck.id);
    const refetchedFresh = queueMod.getJob(fresh.id);
    assert.equal(refetchedStuck.status, "succeeded");
    assert.equal(refetchedFresh.status, "succeeded");

    const artifacts = queueMod.getArtifactsByWorkItem(wi.id, "response");
    const stuckArtifact = artifacts.find((a) => a.job_id === stuck.id);
    assert.ok(stuckArtifact, "synthetic response artifact stored for timed-out child");
    assert.match(stuckArtifact.content_long, /timed out/i);
    assert.match(stuckArtifact.content_long, /alpha/);
  });

  it("ignores queued fanout children that never started (queue saturation)", () => {
    const wi = queueMod.createWorkItem("Audit S", "look into S");
    const waiting = createFanoutChild({ wi, label: "epsilon", index: 0 });

    const futureMs = Date.now() + 60 * 60 * 1000;
    const result = fanoutMod.expireStuckFanoutChildren({ timeoutSec: 60, nowMs: futureMs });

    assert.equal(result.expired, 0, "never-leased children must not be force-succeeded");
    assert.equal(queueMod.getJob(waiting.id).status, "queued");
  });

  it("ignores fanout children that are still leased or running", () => {
    const wi = queueMod.createWorkItem("Audit Y", "look into Y");
    const child = createFanoutChild({ wi, label: "gamma", index: 0 });
    // Transition into a non-queued status to simulate an active worker
    queueMod.updateJobStatus(child.id, "leased");

    const futureMs = Date.now() + 60 * 60 * 1000;
    const result = fanoutMod.expireStuckFanoutChildren({ timeoutSec: 60, nowMs: futureMs });

    assert.equal(result.expired, 0, "leased children must not be force-succeeded");
    assert.equal(queueMod.getJob(child.id).status, "leased");
  });

  it("ignores solo and synth research jobs", () => {
    const wi = queueMod.createWorkItem("Audit Z", "look into Z");
    const solo = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research: solo",
      payload_json: JSON.stringify({ role_mode: "solo" }),
    });
    const synth = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research synthesis",
      payload_json: JSON.stringify({
        role_mode: "synth",
        fanout_run_id: "fanout-test",
        child_job_ids: [],
      }),
    });

    const futureMs = Date.now() + 60 * 60 * 1000;
    const result = fanoutMod.expireStuckFanoutChildren({ timeoutSec: 60, nowMs: futureMs });

    assert.equal(result.expired, 0);
    assert.equal(queueMod.getJob(solo.id).status, "queued");
    assert.equal(queueMod.getJob(synth.id).status, "queued");
  });

  it("emits research.fanout_child_timed_out events with branch metadata", () => {
    const wi = queueMod.createWorkItem("Audit Q", "look into Q");
    const child = createFanoutChild({ wi, label: "delta", index: 2 });
    markStartedAndRequeued(child.id);

    const futureMs = Date.now() + 60 * 60 * 1000;
    fanoutMod.expireStuckFanoutChildren({ timeoutSec: 60, nowMs: futureMs });

    const events = queueMod.getEvents(child.id, 10);
    const timeoutEvent = events.find((e) => e.event_type === "research.fanout_child_timed_out");
    assert.ok(timeoutEvent, "should emit a fanout_child_timed_out event");
    const parsed = typeof timeoutEvent.event_json === "string"
      ? JSON.parse(timeoutEvent.event_json)
      : timeoutEvent.event_json;
    assert.equal(parsed.fanout_run_id, "fanout-test");
    assert.equal(parsed.branch?.label, "delta");
    assert.equal(parsed.branch_index, 2);
  });

  it("throttles repeat sweeps via maybeExpireStuckFanoutChildren", () => {
    const wi = queueMod.createWorkItem("Audit R", "look into R");
    createFanoutChild({ wi, label: "first", index: 0 });

    const futureMs = Date.now() + 60 * 60 * 1000;
    // Note: the throttled wrapper uses the default 20-minute timeout, so a
    // future nowMs is needed for the cutoff to actually expire the row.
    const first = fanoutMod.maybeExpireStuckFanoutChildren({ nowMs: futureMs });
    assert.equal(first.attempted, true);
    assert.equal(first.ok, true);

    // Second call within the interval window must be skipped.
    const second = fanoutMod.maybeExpireStuckFanoutChildren({ nowMs: futureMs + 1000 });
    assert.equal(second.attempted, false);
    assert.equal(second.skipped, "interval");
  });
});
