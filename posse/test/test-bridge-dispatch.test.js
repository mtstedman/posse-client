import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_COMMANDS } from "../lib/catalog/bridge.js";
import {
  createErrorAck,
  dispatchBridgeCommandFrame,
} from "../lib/domains/bridge/functions/command-dispatch.js";
import {
  createJob,
  createWorkItem,
  flushEventsNow,
  getArtifactsByWorkItem,
  getEventsByWorkItem,
  getJob,
  getWorkItem,
  logEvent,
  setJobResult,
  updateJobStatus,
  updateWorkItemStatus,
} from "../lib/domains/queue/functions/index.js";
import { createPlanApprovalGate } from "../lib/domains/planning/functions/plan-approval.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

describe("bridge command dispatch", () => {
  it("allows local read commands and rejects non-allowlisted commands", () => withTempRuntimeDb(async () => {
    createWorkItem("Bridge item", "visible through the bridge");

    const listed = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "q1",
      name: BRIDGE_COMMANDS.QUEUE_LIST,
      args: {},
    });
    assert.equal(listed.ok, true);
    assert.equal(listed.command_id, "q1");
    assert.equal(listed.v, 1);
    assert.equal(listed.type, "ack");
    assert.equal(listed.result.total, 1);

    const rejected = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "bad1",
      name: "queue.delete",
      args: {},
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "command_not_allowed");
  }));

  it("uses a protocol-valid command id for malformed frames", () => {
    const ack = createErrorAck(null, "invalid_json");
    assert.equal(ack.command_id, "unknown");
    assert.equal(ack.ok, false);
  });

  it("rejects command frames without the protocol version", () => withTempRuntimeDb(async () => {
    const ack = await dispatchBridgeCommandFrame({
      type: "command",
      id: "missing-version",
      name: BRIDGE_COMMANDS.QUEUE_LIST,
      args: {},
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, "unsupported_version");
  }));

  it("keeps default queue listing and snapshots active-only where required", () => withTempRuntimeDb(async () => {
    const activeWi = createWorkItem("Active bridge item", "still in flight");
    const activeJob = createJob({ work_item_id: activeWi.id, job_type: "dev", title: "Active job" });
    const doneWi = createWorkItem("Done bridge item", "already completed");
    const doneJob = createJob({ work_item_id: doneWi.id, job_type: "dev", title: "Done job" });
    updateJobStatus(doneJob.id, "succeeded");
    updateWorkItemStatus(doneWi.id, "complete");

    const queue = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "queue-active",
      name: BRIDGE_COMMANDS.QUEUE_LIST,
      args: {},
    });

    assert.equal(queue.ok, true);
    assert.deepEqual(queue.result.work_items.map((wi) => wi.id), [activeWi.id]);
    assert.equal(queue.result.total, 1);

    const snapshot = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "snapshot-active",
      name: BRIDGE_COMMANDS.STATE_SNAPSHOT,
      args: {},
    });

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.result.jobs.some((job) => Number(job.id) === Number(activeJob.id)), true);
    assert.equal(snapshot.result.jobs.some((job) => Number(job.id) === Number(doneJob.id)), false);
  }));

  it("caps snapshot jobs and gate arrays independently of work items", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Bridge snapshot limit", "active jobs should be capped");
    createWorkItem("Second snapshot item", "proves work item cap is still applied");
    createJob({ work_item_id: wi.id, job_type: "dev", title: "First active job" });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const planGate = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Plan approval",
      payload_json: JSON.stringify({ subtype: "plan_approval", questions: ["Approve?"] }),
    });
    updateJobStatus(planGate.id, "waiting_on_human");
    const genericGate = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Question",
      payload_json: JSON.stringify({ questions: ["Proceed?"] }),
    });
    updateJobStatus(genericGate.id, "waiting_on_human");

    const snapshot = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "snapshot-limit",
      name: BRIDGE_COMMANDS.STATE_SNAPSHOT,
      args: { limit: 1 },
    });

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.result.work_items.length, 1);
    assert.equal(snapshot.result.jobs.length, 1);
    assert.equal(snapshot.result.open_gates.length, 1);
    assert.equal(snapshot.result.pending_human_input.length, 1);
    assert.equal(snapshot.result.pending_plan_gates.length, 1);
    assert.equal(snapshot.result.pending_plan_gates[0].payload.subtype, "plan_approval");
  }));

  it("returns an events.tail envelope without a ChangeStream context", () => withTempRuntimeDb(async () => {
    logEvent({
      event_type: "system.bridge_tail.fallback",
      actor_type: "system",
      message: "fallback tail event",
    });
    flushEventsNow();

    const ack = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "tail-fallback",
      name: BRIDGE_COMMANDS.EVENTS_TAIL,
      args: { since_event_id: 0, limit: 10 },
    });

    assert.equal(ack.ok, true);
    assert.equal(Array.isArray(ack.result.events), true);
    assert.equal(ack.result.events.length, 1);
    assert.equal(ack.result.events[0].event_type, "system.bridge_tail.fallback");
    assert.equal(ack.result.head_event_id, Number(ack.result.events[0].id));
  }));

  it("approves pending plan gates through existing planning core", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Bridge plan", "needs approval");
    const planJob = createJob({ work_item_id: wi.id, job_type: "plan", title: "Plan" });
    const devJob = createJob({ work_item_id: wi.id, job_type: "dev", title: "Build" });
    const gateId = createPlanApprovalGate(planJob, [devJob.id], { tasks: 1 });

    const ack = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "p1",
      name: BRIDGE_COMMANDS.PLAN_APPROVE,
      args: { job_id: gateId },
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.result.ok, true);
    assert.equal(getJob(gateId).status, "succeeded");
    assert.equal(getWorkItem(wi.id).plan_approval_state, "approved");
  }));

  it("keeps legacy id as a work item id for plan gate commands", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Bridge legacy plan id", "needs approval");
    const planJob = createJob({ work_item_id: wi.id, job_type: "plan", title: "Plan" });
    const devJob = createJob({ work_item_id: wi.id, job_type: "dev", title: "Build" });
    const gateId = createPlanApprovalGate(planJob, [devJob.id], { tasks: 1 });

    const ack = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "legacy-plan-id",
      name: BRIDGE_COMMANDS.PLAN_APPROVE,
      args: { id: wi.id },
    });

    assert.equal(ack.ok, true);
    assert.equal(ack.result.ok, true);
    assert.equal(getJob(gateId).status, "succeeded");
    assert.equal(getWorkItem(wi.id).plan_approval_state, "approved");
    const audit = getEventsByWorkItem(wi.id).find((event) => event.event_type === "bridge.command_mutation");
    assert.ok(audit);
    const auditJson = JSON.parse(audit.event_json);
    assert.equal(auditJson.command, BRIDGE_COMMANDS.PLAN_APPROVE);
    assert.equal(auditJson.work_item_id, wi.id);
    assert.equal(auditJson.job_id, null);
    assert.equal(auditJson.ok, true);
  }));

  it("answers parked human-input jobs without going through TTY display", () => withTempRuntimeDb(async (projectDir) => {
    const wi = createWorkItem("Bridge human input", "needs an answer");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Question",
      max_attempts: 1,
      payload_json: JSON.stringify({ questions: ["Proceed?"] }),
    });
    updateJobStatus(job.id, "waiting_on_human");

    const ack = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "h1",
      name: BRIDGE_COMMANDS.ASK,
      args: { job_id: job.id, response: "yes, proceed" },
    }, { projectDir });

    assert.equal(ack.ok, true);
    assert.equal(ack.result.ok, true);
    assert.equal(getJob(job.id).status, "succeeded");
    const artifacts = getArtifactsByWorkItem(wi.id);
    assert.equal(artifacts.some((artifact) => /yes, proceed/.test(artifact.content_long || "")), true);
  }));

  it("lists jobs and open gates using contract command names", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Bridge gates", "needs a gate list");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Question",
      payload_json: JSON.stringify({ questions: ["Proceed?"] }),
    });
    updateJobStatus(job.id, "waiting_on_human");

    const jobs = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "j1",
      name: BRIDGE_COMMANDS.JOBS_LIST,
      args: { work_item_id: wi.id },
    });
    assert.equal(jobs.ok, true);
    assert.equal(jobs.result.jobs.length, 1);

    const gates = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "g1",
      name: BRIDGE_COMMANDS.GATES_LIST,
      args: { work_item_id: wi.id },
    });
    assert.equal(gates.ok, true);
    assert.equal(gates.result.gates.length, 1);
    assert.equal(gates.result.gates[0].job_id, job.id);
    assert.equal(gates.result.gates[0].kind, "human_input");
  }));

  it("requires feedback on the legacy work-item review reject path", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Legacy review reject", "missing feedback should fail");

    const ack = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "reject-no-feedback",
      name: BRIDGE_COMMANDS.REVIEW_REJECT,
      args: { work_item_id: wi.id },
    });

    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, "invalid_args");
    assert.equal(ack.error.message, "missing_feedback");
  }));

  it("refuses work-item review decisions when no review is pending", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Queued review target", "not actually reviewable");

    const approved = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "review-approve-queued",
      name: BRIDGE_COMMANDS.REVIEW_APPROVE,
      args: { work_item_id: wi.id },
    });
    assert.equal(approved.ok, false);
    assert.equal(approved.error.code, "not_found");
    assert.equal(approved.error.message, "no_pending_review");

    const rejected = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "review-reject-queued",
      name: BRIDGE_COMMANDS.REVIEW_REJECT,
      args: { work_item_id: wi.id, feedback: "try again" },
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, "not_found");
    assert.equal(rejected.error.message, "no_pending_review");

    const fresh = getWorkItem(wi.id);
    assert.equal(fresh.status, "queued");
    assert.equal(fresh.description, wi.description);
  }));

  it("refuses review job_id decisions against generic human-input gates", () => withTempRuntimeDb(async (projectDir) => {
    const wi = createWorkItem("Generic human input", "should still require ask");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "human_input",
      title: "Question",
      max_attempts: 1,
      payload_json: JSON.stringify({ questions: ["Proceed?"] }),
    });
    updateJobStatus(job.id, "waiting_on_human");

    const ack = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "review-generic-job",
      name: BRIDGE_COMMANDS.REVIEW_APPROVE,
      args: { job_id: job.id },
    }, { projectDir });

    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, "wrong_gate_kind");
    assert.equal(getJob(job.id).status, "waiting_on_human");
  }));

  it("redacts sensitive job and event JSON in bridge state APIs", () => withTempRuntimeDb(async () => {
    const wi = createWorkItem("Bridge redaction", "mask secrets in state APIs");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Secret-bearing job",
      payload_json: JSON.stringify({
        api_key: "sk-secret-payload",
        nested: { note: "Authorization: Bearer nested-secret" },
        token_budget_input: 123,
      }),
    });
    setJobResult(job.id, {
      authorization: "Bearer result-secret",
      ok: true,
    });
    logEvent({
      work_item_id: wi.id,
      job_id: job.id,
      event_type: "system.bridge_redaction.fixture",
      actor_type: "system",
      message: "redaction fixture",
      event_json: JSON.stringify({
        authorization: "Bearer event-secret",
        note: "sent sk-event-secret",
      }),
    });
    flushEventsNow();

    const jobs = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "redacted-jobs",
      name: BRIDGE_COMMANDS.JOBS_LIST,
      args: { work_item_id: wi.id },
    });
    assert.equal(jobs.ok, true);
    assert.equal(jobs.result.jobs[0].payload.api_key, "[REDACTED]");
    assert.equal(jobs.result.jobs[0].payload.nested.note, "Authorization: Bearer [REDACTED]");
    assert.equal(jobs.result.jobs[0].payload.token_budget_input, 123);
    assert.equal(jobs.result.jobs[0].result.authorization, "[REDACTED]");

    const events = await dispatchBridgeCommandFrame({
      v: 1,
      type: "command",
      id: "redacted-events",
      name: BRIDGE_COMMANDS.EVENTS_TAIL,
      args: { work_item_id: wi.id, limit: 10 },
    });
    assert.equal(events.ok, true);
    const redacted = events.result.events.find((event) => event.event_type === "system.bridge_redaction.fixture");
    assert.equal(redacted.event.authorization, "[REDACTED]");
    assert.equal(redacted.event.note, "sent sk-[REDACTED]");
  }));
});
