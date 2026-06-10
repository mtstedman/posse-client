import {
  it,
  assert,
  suite,
  runtimeModules,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Assessor verdict normalization", () => {
  it("normalizes uppercase verdict JSON and lifts summary into reasons", () => {
    const { assessorMod } = runtimeModules;
    const normalized = assessorMod._normalizeAssessorVerdictShape({
      verdict: "PASS",
      summary: "All CSS changes verified in actual files.",
    }, '{"verdict":"PASS"}');

    assert.equal(normalized.verdict, "pass");
    assert.deepEqual(normalized.reasons, ["All CSS changes verified in actual files."]);
    assert.deepEqual(normalized.spawn_jobs, []);
    assert.deepEqual(normalized.human_questions, []);
  });

  it("treats assessment as an alias for verdict", () => {
    const { assessorMod } = runtimeModules;
    const normalized = assessorMod._normalizeAssessorVerdictShape({
      assessment: "PASS",
      summary: "Implementation is complete and correct.",
    }, '{"assessment":"PASS"}');

    assert.equal(normalized.verdict, "pass");
    assert.deepEqual(normalized.reasons, ["Implementation is complete and correct."]);
    assert.deepEqual(normalized.spawn_jobs, []);
    assert.deepEqual(normalized.human_questions, []);
  });

  it("treats status as an alias for verdict", () => {
    const { assessorMod } = runtimeModules;
    const normalized = assessorMod._normalizeAssessorVerdictShape({
      status: "FAIL",
      confidence: "High",
      reason: "Missing manifest entry.",
    }, '{"status":"FAIL"}');

    assert.equal(normalized.verdict, "fail");
    assert.equal(normalized.confidence, "high");
    assert.deepEqual(normalized.reasons, ["Missing manifest entry."]);
    assert.deepEqual(normalized.spawn_jobs, []);
    assert.deepEqual(normalized.human_questions, []);
  });

  it("normalizes off-enum confidence before writing assessor verdicts", () => {
    resetRuntimeDb();
    const { assessorMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Confidence normalization", "avoid CHECK failures");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Normalize assessor confidence",
      payload_json: JSON.stringify({ task_spec: "ok" }),
    });

    assessorMod.processVerdict(job, {
      verdict: "pass",
      confidence: "very high",
      reasons: ["ok"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    const fresh = queueMod.getJob(job.id);
    assert.equal(fresh.assessor_verdict, "pass");
    assert.equal(fresh.assessor_confidence, "high");
  });

  it("converts pass below the assessment confidence floor into needs_review", () => {
    resetRuntimeDb();
    const { assessorMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Risk confidence floor", "high risk needs review below high confidence");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess high-risk pass",
      payload_json: JSON.stringify({
        task_spec: "Update auth policy",
        _assess_pass_confidence_floor: "high",
      }),
    });

    const result = assessorMod.processVerdict(job, {
      verdict: "pass",
      confidence: "medium",
      reasons: ["Looks correct but tests were not rerun"],
      spawn_jobs: [],
      human_questions: [],
    }, { emit: () => {} });

    const fresh = queueMod.getJob(job.id);
    assert.equal(result.action, "needs_review");
    assert.equal(fresh.assessor_verdict, "needs_review");
    assert.equal(fresh.assessor_confidence, "medium");
    assert.equal(fresh.status, "waiting_on_review");
    assert.equal(result.spawnedJobs.length, 1);
  });

  it("unwraps single-element verdict arrays that use status/result aliases", async () => {
    resetRuntimeDb();
    const { assessorMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Assess array", "exercise verdict alias unwrap");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess array response",
      payload_json: JSON.stringify({ task_spec: "Return a valid verdict" }),
    });

    const verdict = await assessorMod.assessResult(job, "worker output", {
      cwd: process.cwd(),
      disableAtlas: true,
      trackedCall: async () => ({
        output: "```json\n[{\"status\":\"PASS\",\"confidence\":\"moderate\",\"summary\":\"verified\"}]\n```",
      }),
    });

    assert.equal(verdict.verdict, "pass");
    assert.equal(verdict.confidence, "medium");
    assert.deepEqual(verdict.reasons, ["verified"]);
  });

  it("treats repaired truncated assessor JSON as parse_error", async () => {
    resetRuntimeDb();
    const { assessorMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Assess repaired", "avoid trusting repaired JSON");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess repaired response",
      payload_json: JSON.stringify({ task_spec: "Return a valid verdict" }),
    });

    const verdict = await assessorMod.assessResult(job, "worker output", {
      cwd: process.cwd(),
      disableAtlas: true,
      trackedCall: async () => ({
        output: "```json\n{\"verdict\":\"pass\",\"confidence\":\"high\"\n```",
      }),
    });

    assert.equal(verdict.verdict, "parse_error");
    assert.match(verdict.reasons[0], /truncated|required repair|synthesized verdict/i);
  });

  it("reports JSON null assessor responses distinctly from no JSON", async () => {
    resetRuntimeDb();
    const { assessorMod, queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Assess null", "exercise JSON null diagnostics");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Assess null response",
      payload_json: JSON.stringify({ task_spec: "Return a valid verdict" }),
    });

    const verdict = await assessorMod.assessResult(job, "worker output", {
      cwd: process.cwd(),
      disableAtlas: true,
      trackedCall: async () => ({ output: "```json\nnull\n```" }),
    });

    assert.equal(verdict.verdict, "parse_error");
    assert.match(verdict.reasons[0], /JSON null/);
  });
});
