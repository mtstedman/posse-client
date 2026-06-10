import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let Worker;
let runtimeDir;
let runtimeDbPath;

function resetRuntimeDb() {
  dbMod.closeDb();
  try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
  dbMod.getDb();
}

describe("Worker._dispatch", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-role-phase7-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    ({ Worker } = await import("../lib/domains/worker/classes/Worker.js"));
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

  it("routes class-backed job types through the injected agent", async () => {
    const worker = new Worker({
      projectDir: runtimeDir,
      silent: true,
      providerClient: {
        call: async () => ({ output: "ok", stats: {} }),
      },
    });
    let attemptCtx = null;
    worker.roleRegistry.roles.set("research", {
      run: async (job, ctx) => {
        attemptCtx = ctx;
        return `agent:${job.type}`;
      },
    });

    const output = await worker._dispatch({
      id: 1,
      job_type: "research",
      work_item_id: 1,
      payload_json: "{}",
      title: "Research: dispatch",
    }, "standard", 3, 7);

    assert.equal(output, "agent:research");
    assert.deepEqual(attemptCtx, { tier: "standard", attemptId: 7, attemptCount: 3 });
  });

  it("throws for provider job types without a registered agent", async () => {
    const worker = new Worker({
      projectDir: runtimeDir,
      silent: true,
      providerClient: {
        call: async () => ({ output: "ok", stats: {} }),
      },
    });
    worker.roleRegistry.roles.delete("research");

    await assert.rejects(
      () => worker._dispatch({
        id: 2,
        job_type: "research",
        work_item_id: 1,
        payload_json: "{}",
        title: "Research: missing agent",
      }, "standard", 1, 8),
      /Unknown job type: research/,
    );
  });
});
