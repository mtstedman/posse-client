import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Pipeline health summary", () => {
  beforeEach(() => { resetRuntimeDb(); });

  it("surfaces dead letters, stuck jobs, parked jobs, and error signatures", () => {
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Health summary", "desc");
    const dead = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "plan",
      title: "Dead planner",
    });
    queueMod.updateJobStatus(dead.id, "dead_letter");
    queueMod.setJobError(dead.id, "Planner output could not be parsed as a JSON task array");

    const running = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Stuck runner",
    });
    queueMod.updateJobStatus(running.id, "running");

    const waiting = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Waiting on human",
    });
    queueMod.updateJobStatus(waiting.id, "waiting_on_human");

    const db = runtimeModules.dbMod.getDb();
    db.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", running.id);

    const health = queueMod.getPipelineHealth({ staleAfterHours: 1, signatureLimit: 3 });

    assert.ok(health.deadLettersByType.some(row => row.job_type === "plan" && row.count === 1));
    assert.ok(health.stuckJobs.some(job => job.id === running.id));
    assert.ok(health.parkedJobs.some(job => job.id === waiting.id));
    assert.ok(health.topErrorSignatures.some(row => /Planner output could not be parsed/.test(row.error_signature)));
  });

  it("reports provider last-success and last-failure timestamps from agent calls", () => {
    const { queueMod, dbMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Provider health rows", "desc");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Provider telemetry",
    });

    const db = dbMod.getDb();
    db.prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, provider, status, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(wi.id, job.id, "dev", "standard", "openai", "failed", "2026-04-17T12:00:00.000Z", "2026-04-17T12:00:00.000Z");
    db.prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, model_tier, provider, status, created_at, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(wi.id, job.id, "dev", "standard", "openai", "succeeded", "2026-04-17T12:05:00.000Z", "2026-04-17T12:05:00.000Z");

    const health = queueMod.getPipelineHealth();
    const openai = health.providerHealth.find((row) => row.provider === "openai");
    assert.ok(openai, "expected provider health row for openai");
    assert.equal(openai.total_calls, 2);
    assert.equal(openai.succeeded_calls, 1);
    assert.equal(openai.failed_calls, 1);
    assert.equal(openai.last_success_at, "2026-04-17T12:05:00.000Z");
    assert.equal(openai.last_failure_at, "2026-04-17T12:00:00.000Z");
  });
});
