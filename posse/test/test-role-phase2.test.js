import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let queueMod;
let DelegateRole;
let SummaryRole;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

function parsePayload(row) {
  try {
    return typeof row.payload_json === "string" ? JSON.parse(row.payload_json) : (row.payload_json || {});
  } catch {
    return {};
  }
}

describe("SummaryRole + DelegateRole behavior", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-role-phase2-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    ({ DelegateRole } = await import("../lib/domains/worker/classes/roles/delegate.js"));
    ({ SummaryRole } = await import("../lib/domains/worker/classes/roles/summary.js"));
    resetRuntimeDb();
  });

  beforeEach(() => {
    resetRuntimeDb();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    setRuntimePathOverridesForTests(null);
  });

  it("runs SummaryRole through the BaseRole template and stores a summary artifact", async () => {
    const wi = queueMod.createWorkItem("Summary role WI", "Condense prior outputs");
    const sourceJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Build feature",
    });
    queueMod.storeArtifact({
      work_item_id: wi.id,
      job_id: sourceJob.id,
      artifact_type: "response",
      content_long: "Built the feature and added tests.",
    });
    const summaryJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "summarize",
      title: "Summarize work",
      provider: "claude",
    });
    const lease = queueMod.acquireLease(summaryJob.id, "role-phase2", 900);
    const { attempt } = queueMod.incrementAndCreateAttempt(summaryJob.id, lease.leaseToken, "planner", "claude", "low");
    const calls = [];
    const role = new SummaryRole({
      providerClient: {
        call: async (prompt, opts, meta) => {
          calls.push({ prompt, opts, meta });
          return { output: "Short summary", stats: {} };
        },
      },
      context: { projectDir: runtimeDir },
      deps: {
        currentExecutionProvider: (job) => job.provider,
        loadNudges: () => "NUDGE: keep it short",
        shortJobTitle: (job) => job.title,
      },
    });

    const output = await role.run(summaryJob, { tier: "cheap", attemptId: attempt.id });

    assert.equal(output, "Short summary");
    assert.equal(role.getRole(), "planner");
    assert.equal(role.hasCustomRun(), false);
    assert.equal(typeof role.assembleContext, "function");
    assert.equal(typeof role.buildContract, "function");
    assert.equal(typeof role.composePrompt, "function");
    assert.equal(typeof role.processOutput, "function");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.role, "planner");
    assert.equal(calls[0].opts.modelTier, "cheap");
    assert.equal(calls[0].meta.jobProvider, "claude");
    assert.match(calls[0].prompt, /Summarize all the work done/);
    assert.match(calls[0].prompt, /Built the feature and added tests/);
    assert.match(calls[0].prompt, /NUDGE: keep it short/);
    assert.doesNotMatch(await role.assembleContext(summaryJob, {}), /Summarize all the work done/);
    assert.match(role.buildContract({ job: summaryJob, ctx: {} }), /Summarize all the work done/);

    const summaries = queueMod.getArtifacts(summaryJob.id, "summary");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].attempt_id, attempt.id);
    assert.equal(summaries[0].content_long, "Short summary");
  });

  it("runs DelegateRole through the BaseRole template and applies provider assignments", async () => {
    const wi = queueMod.createWorkItem("Delegate role WI", "Assign providers");
    const targetJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Implement feature",
    });
    const delegateJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "delegate",
      title: "Delegate pending jobs",
      provider: "claude",
      payload_json: {
        provider_map: {
          dev: ["claude"],
          assessor: ["claude"],
          artificer: ["claude"],
        },
        pending_jobs: [{ job_id: targetJob.id, title: targetJob.title }],
      },
    });
    const calls = [];
    const emitted = [];
    const role = new DelegateRole({
      providerClient: {
        call: async (prompt, opts, meta) => {
          calls.push({ prompt, opts, meta });
          return {
            output: JSON.stringify([{
              job_id: targetJob.id,
              provider: "claude",
              model_tier: "cheap",
              reasoning_effort: "low",
              reason: "balanced sample",
            }]),
            stats: {},
          };
        },
      },
      context: {
        projectDir: runtimeDir,
        parsePayload,
        emit: (jobId, message) => emitted.push({ jobId, message }),
      },
      deps: {
        currentExecutionProvider: (job) => job.provider,
        getDelegationMode: () => "ml",
        loadNudges: () => "NUDGE: spread work",
        shortJobTitle: (job) => job.title,
      },
    });

    const output = await role.run(delegateJob, { tier: "cheap", attemptId: 123 });
    const updatedTarget = queueMod.getJob(targetJob.id);

    assert.match(output, /balanced sample/);
    assert.equal(role.getRole(), "delegator");
    assert.equal(role.hasCustomRun(), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.role, "delegator");
    assert.equal(calls[0].opts.modelTier, "cheap");
    assert.equal(calls[0].meta.jobProvider, "claude");
    assert.match(calls[0].prompt, /AVAILABLE PROVIDERS PER ROLE/);
    assert.match(calls[0].prompt, /Implement feature/);
    assert.match(calls[0].prompt, /ROUTING RULE/);
    const delegateContext = await role.assembleContext(delegateJob, {});
    assert.match(delegateContext, /PENDING TASKS/);
    assert.doesNotMatch(delegateContext, /ROUTING RULE/);
    assert.match(role.buildContract({ job: delegateJob, ctx: {} }), /ROUTING RULE/);
    assert.equal(updatedTarget.provider, "claude");
    assert.equal(updatedTarget.model_tier, "cheap");
    assert.equal(updatedTarget.reasoning_effort, "low");
    assert.ok(emitted.some((entry) => entry.jobId === delegateJob.id && entry.message.includes("[delegator]")));
  });

  it("runs DelegateRole deterministic mode through hooks without a provider call", async () => {
    const wi = queueMod.createWorkItem("Delegate js mode WI", "Assign providers deterministically");
    const targetJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Implement deterministic feature",
    });
    const delegateJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "delegate",
      title: "Delegate pending jobs",
      provider: "claude",
      payload_json: {
        provider_map: {
          dev: ["claude"],
          assessor: ["claude"],
          artificer: ["claude"],
        },
        pending_jobs: [{ job_id: targetJob.id, title: targetJob.title }],
      },
    });
    const emitted = [];
    const role = new DelegateRole({
      providerClient: {
        call: async () => {
          throw new Error("deterministic delegate should not call provider");
        },
      },
      context: {
        projectDir: runtimeDir,
        parsePayload,
        emit: (jobId, message) => emitted.push({ jobId, message }),
      },
      deps: {
        buildDeterministicDelegations: () => [{
          job_id: targetJob.id,
          provider: "claude",
          model_tier: "cheap",
          reasoning_effort: "low",
          reason: "deterministic route",
        }],
        currentExecutionProvider: (job) => job.provider,
        getDelegationMode: () => "js",
        loadNudges: () => "",
        shortJobTitle: (job) => job.title,
      },
    });

    const output = await role.run(delegateJob, { tier: "cheap", attemptId: 124 });
    const updatedTarget = queueMod.getJob(targetJob.id);

    assert.match(output, /deterministic route/);
    assert.equal(role.hasCustomRun(), false);
    assert.equal(updatedTarget.provider, "claude");
    assert.equal(updatedTarget.model_tier, "cheap");
    assert.equal(updatedTarget.reasoning_effort, "low");
    assert.ok(emitted.some((entry) => entry.jobId === delegateJob.id && entry.message.includes("[delegator]")));
  });

});
