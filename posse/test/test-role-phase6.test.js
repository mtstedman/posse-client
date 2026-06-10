import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let queueMod;
let AssessorRole;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

describe("AssessorRole.assessResult", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-role-phase6-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    queueMod = await import("../lib/domains/queue/functions/index.js");
    ({ AssessorRole } = await import("../lib/domains/worker/classes/roles/assessor.js"));
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

  it("assesses through the injected provider client by default", async () => {
    const wi = queueMod.createWorkItem("Assess me", "Verify a simple output");
    const job = queueMod.createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Dev: simple output",
      payload_json: JSON.stringify({ task_spec: "Produce a simple output" }),
    });
    let sawPrompt = false;
    const role = new AssessorRole({
      providerClient: {
        call: async (prompt) => {
          sawPrompt = String(prompt).includes("TASK SPECIFICATION");
          return {
            output: JSON.stringify({
              verdict: "pass",
              confidence: "high",
              reasons: ["ok"],
              spawn_jobs: [],
              human_questions: [],
            }),
            stats: {},
          };
        },
      },
      context: { projectDir: runtimeDir },
      deps: {},
    });

    const verdict = await role.assessResult(job, "worker output", { cwd: runtimeDir });

    assert.equal(sawPrompt, true);
    assert.equal(verdict.verdict, "pass");
    assert.equal(verdict.confidence, "high");
  });
});
