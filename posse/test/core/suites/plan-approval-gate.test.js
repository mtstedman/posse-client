import {
  it,
  beforeEach,
  assert,
  suite,
  runtimeModules,
  now,
  createJob,
  resetRuntimeDb,
} from "../support/core-harness.js";

let db;

suite("Plan approval gate", () => {
  beforeEach(() => resetRuntimeDb());

  it("isPlanApprovalEnabled respects DB setting and runtime override", async () => {
    const { isPlanApprovalEnabled, setPlanApprovalOverrideForRun } = await import("../../../lib/domains/planning/functions/plan-approval.js");
    const { queueMod } = runtimeModules;
    assert.equal(isPlanApprovalEnabled(), false);
    queueMod.setSetting("plan_approval_mode", "true");
    assert.equal(isPlanApprovalEnabled(), true);
    setPlanApprovalOverrideForRun(false);
    assert.equal(isPlanApprovalEnabled(), false);
    queueMod.setSetting("plan_approval_mode", "");
    setPlanApprovalOverrideForRun(true);
    assert.equal(isPlanApprovalEnabled(), true);
    setPlanApprovalOverrideForRun(null);
  });

  it("createPlanApprovalGate blocks downstream jobs until approved", async () => {
    const { createPlanApprovalGate, approvePlan, findPendingGate } = await import("../../../lib/domains/planning/functions/plan-approval.js");
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Gate approve", "t");
    const planJob = queueMod.createJob({ work_item_id: wi.id, job_type: "plan", title: "plan" });
    const dev1 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "d1" });
    const dev2 = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "d2" });

    const gateId = createPlanApprovalGate(planJob, [dev1.id, dev2.id]);
    assert.ok(gateId > 0);

    const gate = queueMod.getJob(gateId);
    assert.equal(gate.status, "waiting_on_human");
    const wiAfter = queueMod.getWorkItem(wi.id);
    assert.equal(wiAfter.plan_approval_state, "pending");

    // Both dev jobs are now blocked on the gate as hard deps.
    const d1Deps = queueMod.getDependencies(dev1.id);
    assert.ok(d1Deps.some((d) => d.depends_on_job_id === gateId));
    const d2Deps = queueMod.getDependencies(dev2.id);
    assert.ok(d2Deps.some((d) => d.depends_on_job_id === gateId));

    assert.equal(findPendingGate(wi.id)?.id, gateId);

    const result = approvePlan(wi.id);
    assert.equal(result.ok, true);
    assert.equal(queueMod.getJob(gateId).status, "succeeded");
    assert.equal(queueMod.getWorkItem(wi.id).plan_approval_state, "approved");
    assert.equal(findPendingGate(wi.id), null);
  });

  it("rejectPlan cancels the gate and all gated downstream jobs", async () => {
    const { createPlanApprovalGate, rejectPlan } = await import("../../../lib/domains/planning/functions/plan-approval.js");
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Gate reject", "t");
    const planJob = queueMod.createJob({ work_item_id: wi.id, job_type: "plan", title: "plan" });
    const dev = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "d" });
    const gateId = createPlanApprovalGate(planJob, [dev.id]);

    const result = rejectPlan(wi.id, { feedback: "scope too broad" });
    assert.equal(result.ok, true);
    assert.equal(result.canceledCount, 1);
    assert.equal(queueMod.getJob(gateId).status, "canceled");
    assert.equal(queueMod.getJob(dev.id).status, "canceled");

    const wiAfter = queueMod.getWorkItem(wi.id);
    assert.equal(wiAfter.plan_approval_state, "rejected");
    assert.equal(wiAfter.plan_rejection_feedback, "scope too broad");
  });

  it("rejectPlan marks artifacts from already-succeeded artificers as rejected", async () => {
    const { createPlanApprovalGate, rejectPlan, respawnAfterRejection } = await import("../../../lib/domains/planning/functions/plan-approval.js");
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Reject artifact output", "t");
    const planJob = queueMod.createJob({ work_item_id: wi.id, job_type: "plan", title: "plan" });
    const imageJob = queueMod.createJob({ work_item_id: wi.id, job_type: "artificer", title: "image" });
    const promoteJob = queueMod.createJob({ work_item_id: wi.id, job_type: "promote", title: "promote image" });
    queueMod.updateJobStatus(imageJob.id, "succeeded");
    queueMod.updateJobStatus(promoteJob.id, "succeeded");
    const artifact = queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: imageJob.id,
      artifact_type: "response",
      content_long: "generated image",
      content_json: { file: "hero.png" },
    });
    createPlanApprovalGate(planJob, [imageJob.id, promoteJob.id]);

    const result = rejectPlan(wi.id, { feedback: "use a different visual direction" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.rejectedArtifactIds, [artifact.id]);
    assert.equal(result.promoteAlreadyRanCount, 1);

    const marked = queueMod.getArtifact(artifact.id);
    const markedJson = JSON.parse(marked.content_json);
    assert.equal(markedJson.plan_rejected, true);
    assert.equal(markedJson.plan_rejection_feedback, "use a different visual direction");
    // Regression: rejection used to write content_json inline on file-backed
    // artifacts, which short-circuits hydration and permanently shadows the
    // payload file. The original content must survive the rejection marking.
    assert.equal(markedJson.file, "hero.png");
    assert.equal(marked.content_long, "generated image");
    const rejectedEvent = queueMod.getEventsByWorkItem(wi.id)
      .find((event) => event.event_type === "plan.rejected");
    const rejectedEventJson = JSON.parse(rejectedEvent.event_json);
    assert.equal(rejectedEventJson.promote_already_ran_count, 1);

    const replan = respawnAfterRejection(wi.id, {
      feedback: "use a different visual direction",
      rejectedArtifactIds: result.rejectedArtifactIds,
    });
    const payload = JSON.parse(queueMod.getJob(replan.researchJobId).payload_json);
    assert.deepEqual(payload.rejected_artifact_ids, [artifact.id]);
  });

  it("respawnAfterRejection spawns a research job carrying the feedback", async () => {
    const { createPlanApprovalGate, rejectPlan, respawnAfterRejection } = await import("../../../lib/domains/planning/functions/plan-approval.js");
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("Replan", "t");
    const planJob = queueMod.createJob({ work_item_id: wi.id, job_type: "plan", title: "plan" });
    const dev = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "d" });
    createPlanApprovalGate(planJob, [dev.id]);
    rejectPlan(wi.id, { feedback: "need different decomposition" });

    const r = respawnAfterRejection(wi.id, { feedback: "need different decomposition" });
    assert.equal(r.ok, true);
    const research = queueMod.getJob(r.researchJobId);
    assert.equal(research.job_type, "research");
    assert.equal(research.model_tier, "strong");
    const payload = JSON.parse(research.payload_json || "{}");
    assert.equal(payload.replan_after_rejection, true);
    assert.equal(payload.previous_rejection_feedback, "need different decomposition");
  });

  it("findPendingGate returns null when no gate has been created", async () => {
    const { findPendingGate } = await import("../../../lib/domains/planning/functions/plan-approval.js");
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("No gate", "t");
    queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "d" });
    assert.equal(findPendingGate(wi.id), null);
  });

  it("approve/reject return { ok: false } without crashing when no gate exists", async () => {
    const { approvePlan, rejectPlan } = await import("../../../lib/domains/planning/functions/plan-approval.js");
    const { queueMod } = runtimeModules;
    const wi = queueMod.createWorkItem("No gate ops", "t");
    const a = approvePlan(wi.id);
    assert.equal(a.ok, false);
    assert.equal(a.reason, "no_pending_gate");
    const r = rejectPlan(wi.id);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_pending_gate");
  });
});
