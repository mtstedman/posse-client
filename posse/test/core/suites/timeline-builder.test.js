import {
  it,
  beforeEach,
  assert,
  path,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Timeline builder", () => {
  beforeEach(() => resetRuntimeDb());

  it("returns null when the work item does not exist", async () => {
    const { buildTimeline } = await import("../../../lib/domains/observability/functions/timeline/index.js");
    assert.equal(buildTimeline(99999), null);
  });

  it("aggregates jobs, attempts, agent calls, dependencies, and events for a WI", async () => {
    const { buildTimeline } = await import("../../../lib/domains/observability/functions/timeline/index.js");
    const { renderTimelineText, renderTimelineJson } = await import("../../../lib/domains/observability/functions/timeline/render.js");
    const { queueMod, dbMod } = runtimeModules;
    const rdb = dbMod.getDb();

    const wi = queueMod.createWorkItem("Timeline smoke", "render end-to-end");
    const researchJob = queueMod.createJob({
      work_item_id: wi.id, job_type: "research", title: "research",
      model_tier: "cheap", provider: "claude",
    });
    const planJob = queueMod.createJob({
      work_item_id: wi.id, job_type: "plan", title: "plan",
      model_tier: "standard", provider: "claude",
    });
    queueMod.addDependency(planJob.id, researchJob.id, "hard");
    const devJob = queueMod.createJob({
      work_item_id: wi.id, job_type: "dev", title: "dev change",
      model_tier: "standard", provider: "claude",
    });
    queueMod.addDependency(devJob.id, planJob.id, "hard");

    // Direct inserts bypass the lease-validation path — the builder only reads
    // the rows, so we don't need lifecycle fidelity here.
    function insertAttempt(jobId, attemptNum, workerType, modelName, status, extra = {}) {
      const info = rdb.prepare(`
        INSERT INTO job_attempts (job_id, attempt_number, worker_type, model_name, status,
          finished_at, duration_ms, prompt_chars, output_chars, error_text, commit_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobId, attemptNum, workerType, modelName, status,
        extra.finishedAt || null, extra.durationMs || null,
        extra.promptChars || null, extra.outputChars || null,
        extra.errorText || null, extra.commitHash || null,
      );
      return info.lastInsertRowid;
    }
    function insertAgentCall(jobId, attemptId, fields) {
      rdb.prepare(`
        INSERT INTO agent_calls (work_item_id, job_id, attempt_id, role, model_tier, model_name, provider,
          input_tokens, output_tokens, status, duration_ms, cost_estimate_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(wi.id, jobId, attemptId,
        fields.role, fields.tier, fields.modelName, fields.provider,
        fields.inputTokens, fields.outputTokens, fields.status,
        fields.durationMs, fields.costUsd);
    }

    // Research: one successful attempt with a recorded agent_call.
    const rAttemptId = insertAttempt(researchJob.id, 1, "researcher", "claude-haiku", "succeeded", {
      durationMs: 1234, outputChars: 1500,
    });
    insertAgentCall(researchJob.id, rAttemptId, {
      role: "researcher", tier: "cheap", modelName: "claude-haiku", provider: "claude",
      inputTokens: 8000, outputTokens: 1500, status: "succeeded",
      durationMs: 1234, costUsd: 0.05,
    });
    queueMod.updateJobStatus(researchJob.id, "succeeded");

    // Dev: two attempts — fail then succeed, second with a commit hash.
    insertAttempt(devJob.id, 1, "dev", "claude-sonnet", "failed", {
      durationMs: 5000, errorText: "missing file X",
    });
    const dAttempt2Id = insertAttempt(devJob.id, 2, "dev", "claude-sonnet", "succeeded", {
      durationMs: 12000, commitHash: "a1b2c3d4e5f6g7h8",
    });
    queueMod.updateJobStatus(devJob.id, "succeeded");
    queueMod.setAssessorVerdict(devJob.id, "pass", "high");

    // Scope-compat event so the renderer surfaces a violation marker.
    queueMod.logEvent({
      work_item_id: wi.id,
      job_id: devJob.id,
      attempt_id: dAttempt2Id,
      event_type: "job.scope_compat_untracked_out_of_scope",
      actor_type: "worker",
      message: "Planner scope bug: 1 untracked file created outside scope",
      event_json: JSON.stringify({ files: ["rogue-new.txt"] }),
    });

    const data = buildTimeline(wi.id);
    assert.ok(data);
    assert.equal(data.workItem.id, wi.id);
    assert.equal(data.workItem.title, "Timeline smoke");
    assert.equal(data.summary.jobCount, 3);
    assert.equal(data.summary.attemptCount, 3);
    assert.equal(data.summary.agentCallCount, 1);

    const jobsById = new Map(data.jobs.map((j) => [j.id, j]));
    const plan = jobsById.get(planJob.id);
    assert.deepEqual(plan.dependsOn.map((d) => d.jobId), [researchJob.id]);
    assert.deepEqual(plan.dependents.map((d) => d.jobId), [devJob.id]);

    const dev = jobsById.get(devJob.id);
    assert.equal(dev.attempts.length, 2);
    assert.equal(dev.attempts[0].status, "failed");
    assert.equal(dev.attempts[1].status, "succeeded");
    assert.equal(dev.attempts[1].commitHash, "a1b2c3d4e5f6g7h8");
    assert.equal(dev.assessorVerdict, "pass");
    assert.equal(dev.assessorConfidence, "high");
    assert.ok(dev.events.some((ev) => ev.eventType === "job.scope_compat_untracked_out_of_scope"));

    const research = jobsById.get(researchJob.id);
    assert.equal(research.attempts.length, 1);
    assert.equal(research.attempts[0].agentCalls.length, 1);
    assert.equal(research.attempts[0].agentCalls[0].role, "researcher");
    assert.equal(research.attempts[0].inputTokens, 8000);
    assert.equal(research.attempts[0].outputTokens, 1500);
    assert.ok(data.summary.totalCostUsd > 0);

    // Renderers must not throw and must include the canonical markers.
    const text = renderTimelineText(data);
    assert.ok(text.includes(`WI#${wi.id}`));
    assert.ok(text.includes("Timeline smoke"));
    assert.ok(text.includes(`Job #${devJob.id}`));
    assert.ok(text.includes("a1b2c3d4"));
    assert.ok(text.includes("scope-compat"));

    const json = renderTimelineJson(data);
    const parsed = JSON.parse(json);
    assert.equal(parsed.workItem.id, wi.id);
    assert.equal(parsed.jobs.length, 3);
  });

  it("renders a WI with no jobs without crashing", async () => {
    const { buildTimeline } = await import("../../../lib/domains/observability/functions/timeline/index.js");
    const { renderTimelineText } = await import("../../../lib/domains/observability/functions/timeline/render.js");
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Empty WI", "nothing here yet");
    const data = buildTimeline(wi.id);
    assert.equal(data.summary.jobCount, 0);
    assert.equal(data.summary.attemptCount, 0);
    const text = renderTimelineText(data);
    assert.ok(text.includes(`WI#${wi.id}`));
  });
});
