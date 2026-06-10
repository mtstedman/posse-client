import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { buildSyntheticResearchBrief } from "../lib/domains/research/functions/routing.js";

let dbMod;
let queueMod;
let artifactMod;
let atlasMod;
let PlannerRole;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

describe("PlannerRole skipped research context", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-planner-skipped-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    artifactMod = await import("../lib/domains/artifacts/functions/index.js");
    atlasMod = await import("../lib/domains/integrations/functions/atlas.js");
    atlasMod.disableAtlasForRun("planner-research-skipped-test");
    ({ PlannerRole } = await import("../lib/domains/worker/classes/roles/planner.js"));
    resetRuntimeDb();
  });

  beforeEach(() => {
    resetRuntimeDb();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    atlasMod?.__resetAtlasRuntimeDisabledForTests?.();
    setRuntimePathOverridesForTests(null);
  });

  it("uses the synthetic brief when research was skipped", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-planner-skipped-project-"));
    try {
      fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "lib", "queue.js"), "export const typo = true;\n", "utf-8");

      const reason = "single-file low-risk edit: typo";
      const wi = queueMod.createWorkItem("Fix typo", "Fix typo in lib/queue.js", "normal", {
        metadata: { deepthink_budget: "low" },
      });
      queueMod.updateWorkItemResearchSkip(wi.id, { skipped: true, reason });
      queueMod.storeArtifact({
        work_item_id: wi.id,
        job_id: null,
        artifact_type: "response",
        content_long: buildSyntheticResearchBrief(reason),
      });
      const planJob = queueMod.createJob({
        work_item_id: wi.id,
        job_type: "plan",
        title: "Plan: Fix typo",
        model_tier: "cheap",
        reasoning_effort: "low",
        payload_json: { research_skipped: true, deepthink_budget: "low" },
      });

      let capturedPrompt = "";
      let capturedTasks = null;
      const role = new PlannerRole({
        providerClient: {
          call: async (prompt) => {
            capturedPrompt = prompt;
            return {
              output: JSON.stringify([{
                title: "Fix typo",
                task_spec: "Fix the typo in lib/queue.js.",
                job_type: "dev",
                model_tier: "cheap",
                dev_mode: "implementation",
                files_to_modify: ["lib/queue.js"],
                success_criteria: ["Typo is fixed."],
                depends_on_index: [],
              }]),
              stats: {},
            };
          },
        },
        context: {
          projectDir,
          parsePayload: (row) => JSON.parse(row.payload_json || "{}"),
          emit: () => {},
          createJobsFromPlan: (_job, tasks) => {
            capturedTasks = tasks;
          },
        },
        deps: {
          loadNudges: () => "",
        },
      });

      await role.run(planJob, { tier: "cheap", attemptId: null });

      const fastDir = path.join(
        artifactMod.contextDir(artifactMod.wiScopeId(wi.id), projectDir),
        "planner",
        "fast",
      );
      const briefPath = path.join(fastDir, "brief.md");
      assert.ok(fs.existsSync(briefPath), "expected planner fast/brief.md");
      assert.match(fs.readFileSync(briefPath, "utf-8"), /Research skipped/);
      assert.match(capturedPrompt, /CONTEXT DIRECTORIES/);
      assert.match(capturedPrompt, /fast\/brief\.md/);
      assert.equal(capturedTasks?.[0]?.title, "Fix typo");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
