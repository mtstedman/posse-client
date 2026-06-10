import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Job } from "../lib/domains/queue/classes/job/Job.js";

function makeDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    getJob: (id) => ({ id, job_type: "dev", status: "queued", work_item_id: 7, payload_json: "{}" }),
    getDependencies: () => [{ depends_on_job_id: 2 }, { depends_on_job_id: 3 }],
    updateJobStatus: (id, status) => calls.push(["updateJobStatus", id, status]),
    setJobResult: (id, result) => calls.push(["setJobResult", id, result]),
    setJobError: (id, text) => calls.push(["setJobError", id, text]),
    setJobContext: (id, text) => calls.push(["setJobContext", id, text]),
    updateJobProvider: (id, provider, modelName) => calls.push(["updateJobProvider", id, provider, modelName]),
    logEvent: (entry) => calls.push(["logEvent", entry]),
    ...overrides,
  };
}

describe("Job", () => {
  it("wraps a row as a snapshot and exposes parsed accessors", () => {
    const agent = { getRole: () => "planner", run: async () => "ok" };
    const job = new Job({
      row: {
        id: 1,
        job_type: "plan",
        status: "queued",
        work_item_id: 7,
        payload_json: "{\"task\":\"build\"}",
        context_text: "rendered context",
      },
      agent,
      deps: makeDeps(),
    });

    assert.equal(job.id, 1);
    assert.equal(job.type, "plan");
    assert.equal(job.status, "queued");
    assert.equal(job.workItemId, 7);
    assert.equal(job.work_item_id, 7);
    assert.deepEqual(job.payload, { task: "build" });
    assert.equal(job.contextText, "rendered context");
    assert.equal(job.getRole(), "planner");
    assert.throws(
      () => { job.provider = "claude"; },
      /Job row field "provider" is read-only/,
    );
  });

  it("keeps dependsOn as ids and resolves lazily through deps", () => {
    const deps = makeDeps({
      getJob: (id) => ({ id, title: `job ${id}` }),
    });
    const job = new Job({
      row: { id: 1, job_type: "dev", status: "queued", work_item_id: 7, payload_json: "{}" },
      deps,
    });

    assert.deepEqual(job.getDependsOnIds(), [2, 3]);
    assert.deepEqual(job.resolveDependencies(), [
      { id: 2, title: "job 2" },
      { id: 3, title: "job 3" },
    ]);
  });

  it("runs through the injected agent and throws without one", async () => {
    const agent = {
      getRole: () => "dev",
      run: async (job, ctx) => ({ id: job.id, tier: ctx.tier }),
    };
    const job = new Job({
      row: { id: 10, job_type: "dev", status: "queued", work_item_id: 7, payload_json: "{}" },
      agent,
      deps: makeDeps(),
    });

    assert.deepEqual(await job.run({ tier: "cheap" }), { id: 10, tier: "cheap" });
    await assert.rejects(
      () => new Job({
        row: { id: 11, job_type: "human_input", status: "queued", work_item_id: 7, payload_json: "{}" },
        deps: makeDeps(),
      }).run(),
      /Job 11 has no agent/,
    );
  });

  it("delegates row mutations through injected deps and updates the snapshot", async () => {
    const deps = makeDeps();
    const job = new Job({
      row: { id: 1, job_type: "dev", status: "queued", work_item_id: 7, payload_json: "{}" },
      deps,
    });

    await job.setStatus("running");
    await job.setResult({ ok: true });
    await job.setError("failed once");
    await job.setContext("context body");
    await job.setProvider("openai", "gpt-test");
    await job.logEvent({ event_type: "job.note", actor_type: "system", message: "hello" });

    assert.equal(job.status, "running");
    assert.equal(job.row.result_json, "{\"ok\":true}");
    assert.equal(job.row.last_error, "failed once");
    assert.equal(job.contextText, "context body");
    assert.equal(job.row.provider, "openai");
    assert.equal(job.row.model_name, "gpt-test");
    assert.deepEqual(deps.calls, [
      ["updateJobStatus", 1, "running"],
      ["setJobResult", 1, { ok: true }],
      ["setJobError", 1, "failed once"],
      ["setJobContext", 1, "context body"],
      ["updateJobProvider", 1, "openai", "gpt-test"],
      ["logEvent", {
        work_item_id: 7,
        job_id: 1,
        event_type: "job.note",
        actor_type: "system",
        message: "hello",
      }],
    ]);
  });

  it("mirrors string results as valid JSON strings", async () => {
    const deps = makeDeps();
    const job = new Job({
      row: { id: 1, job_type: "dev", status: "queued", work_item_id: 7, payload_json: "{}" },
      deps,
    });

    await job.setResult("plain result");

    assert.equal(job.row.result_json, "\"plain result\"");
    assert.equal(JSON.parse(job.row.result_json), "plain result");
  });

  it("refreshes the snapshot from deps.getJob", async () => {
    const deps = makeDeps({
      getJob: () => ({
        id: 1,
        job_type: "dev",
        status: "succeeded",
        work_item_id: 7,
        payload_json: "{\"fresh\":true}",
      }),
    });
    const job = new Job({
      row: { id: 1, job_type: "dev", status: "queued", work_item_id: 7, payload_json: "{}" },
      deps,
    });

    const row = await job.refresh();

    assert.equal(row.status, "succeeded");
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.payload, { fresh: true });
  });
});
