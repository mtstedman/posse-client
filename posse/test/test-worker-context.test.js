import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

let dbMod;
let Worker;
let runtimeDir;
let runtimeDbPath;

describe("Worker public role surface", () => {
  before(async () => {
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-worker-surface-"));
    runtimeDbPath = path.join(runtimeDir, "orchestrator.db");
    setRuntimePathOverridesForTests({ dbPath: runtimeDbPath });

    dbMod = await import("../lib/shared/storage/functions/index.js");
    ({ Worker } = await import("../lib/domains/worker/classes/Worker.js"));
    dbMod.closeDb();
    try { fs.rmSync(runtimeDbPath, { force: true }); } catch {}
    dbMod.getDb();
  });

  after(() => {
    if (dbMod) dbMod.closeDb();
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    setRuntimePathOverridesForTests(null);
  });

  it("keeps parsePayload and emit behavior on the worker itself", () => {
    const lines = [];
    const display = {
      workerLine: (jobId, message) => lines.push({ jobId, message }),
    };
    const worker = new Worker({
      projectDir: runtimeDir,
      display,
      providerClient: {
        call: async () => ({ output: "ok", stats: {} }),
      },
    });

    assert.equal(worker.projectDir, runtimeDir);
    assert.equal(worker.display, display);
    assert.deepEqual(worker.parsePayload({ payload_json: "{\"task\":\"build\"}" }), { task: "build" });

    worker.emit(42, "hello");

    assert.deepEqual(lines, [{ jobId: 42, message: "hello" }]);
  });
});
