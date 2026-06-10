import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let queueMod;
let planApprovalMod;
let pipelineMod;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

describe("research_skipped clearing", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-research-skip-clear-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    planApprovalMod = await import("../lib/domains/planning/functions/plan-approval.js");
    pipelineMod = await import("../lib/domains/worker/functions/helpers/pipeline-continuation.js");
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

  it("clears skipped research before respawning research after plan rejection", () => {
    const wi = queueMod.createWorkItem("Replan skipped WI", "Fix typo in lib/queue.js");
    queueMod.updateWorkItemResearchSkip(wi.id, { skipped: true, reason: "single-file low-risk text edit" });
    const planJob = queueMod.createJob({ work_item_id: wi.id, job_type: "plan", title: "Plan" });
    const devJob = queueMod.createJob({ work_item_id: wi.id, job_type: "dev", title: "Dev" });
    planApprovalMod.createPlanApprovalGate(planJob, [devJob.id]);
    planApprovalMod.rejectPlan(wi.id, { feedback: "needs research" });

    const respawned = planApprovalMod.respawnAfterRejection(wi.id, { feedback: "needs research" });

    assert.equal(respawned.ok, true);
    assert.equal(queueMod.getJob(respawned.researchJobId).job_type, "research");
    const refreshed = queueMod.getWorkItem(wi.id);
    assert.equal(refreshed.research_skipped, 0);
    assert.equal(refreshed.research_skip_reason, null);
  });

  it("clears skipped research when a real research job continues to planning", () => {
    const wi = queueMod.createWorkItem("Plan after real research", "Fix typo in lib/queue.js");
    queueMod.updateWorkItemResearchSkip(wi.id, { skipped: true, reason: "single-file low-risk text edit" });
    const researchJob = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "research",
      title: "Research",
      payload_json: { deepthink_budget: "normal" },
    });
    const worker = {
      parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
      emit: () => {},
    };

    pipelineMod.spawnPlanAfterResearch(worker, researchJob, [
      "# Research",
      "",
      "```json",
      JSON.stringify({ key_files: [], related_files: [], questions_for_human: false, questions: [] }),
      "```",
    ].join("\n"));

    const refreshed = queueMod.getWorkItem(wi.id);
    assert.equal(refreshed.research_skipped, 0);
    assert.equal(refreshed.research_skip_reason, null);
    const planJob = queueMod.listJobsByWorkItem(wi.id).find((job) => job.job_type === "plan");
    assert.ok(planJob, "expected research continuation to spawn a plan job");
  });
});
