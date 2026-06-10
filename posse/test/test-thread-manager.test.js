import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { ThreadManager } from "../lib/shared/concurrency/classes/ThreadManager.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posse-thread-manager-"));

after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function writeWorker(name, source) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, source);
  return pathToFileURL(file);
}

describe("ThreadManager", () => {
  it("routes progress and resolves standard result messages", async () => {
    const workerUrl = writeWorker("result-worker.mjs", `
      import { parentPort, workerData } from "node:worker_threads";
      parentPort.postMessage({ type: "progress", event: { stage: "test", text: "started" } });
      parentPort.postMessage({ type: "result", result: { value: workerData.value } });
    `);
    const manager = new ThreadManager();
    const progress = [];
    const result = await manager.run(workerUrl, {
      label: "result worker",
      workerData: { value: 42 },
      onProgress: (event) => progress.push(event),
    });
    assert.deepEqual(result, { value: 42 });
    assert.deepEqual(progress, [{ stage: "test", text: "started" }]);
  });

  it("hydrates structured worker errors", async () => {
    const workerUrl = writeWorker("error-worker.mjs", `
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage({
        type: "error",
        error: { name: "RangeError", message: "bad range", code: "BAD_RANGE" },
      });
    `);
    const manager = new ThreadManager();
    await assert.rejects(
      manager.run(workerUrl, { label: "error worker" }),
      (err) => {
        assert.equal(err.name, "RangeError");
        assert.equal(err.message, "bad range");
        assert.equal(err.code, "BAD_RANGE");
        return true;
      },
    );
  });

  it("rejects clean worker exits that return no result", async () => {
    const workerUrl = writeWorker("empty-worker.mjs", `
      // Exit cleanly without sending a result message.
    `);
    const manager = new ThreadManager();
    await assert.rejects(
      manager.run(workerUrl, { label: "empty worker" }),
      (err) => {
        assert.equal(err.code, "THREAD_EXIT");
        assert.equal(err.exitCode, 0);
        assert.match(err.message, /exited before returning a result/);
        return true;
      },
    );
  });

  it("aborts active workers", async () => {
    const workerUrl = writeWorker("abort-worker.mjs", `
      setInterval(() => {}, 1000);
    `);
    const manager = new ThreadManager();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop worker")), 25);
    await assert.rejects(
      manager.run(workerUrl, { label: "abort worker", signal: controller.signal }),
      (err) => {
        assert.equal(err.code, "THREAD_ABORTED");
        assert.equal(err.message, "stop worker");
        return true;
      },
    );
  });

  it("times out a busy worker without starving the parent event loop", async () => {
    const workerUrl = writeWorker("busy-worker.mjs", `
      const end = Date.now() + 500;
      while (Date.now() < end) {}
    `);
    const manager = new ThreadManager();
    let ticks = 0;
    const interval = setInterval(() => { ticks += 1; }, 10);
    try {
      await assert.rejects(
        manager.run(workerUrl, { label: "busy worker", timeoutMs: 100 }),
        (err) => {
          assert.equal(err.code, "THREAD_TIMEOUT");
          return true;
        },
      );
    } finally {
      clearInterval(interval);
    }
    assert.ok(ticks > 0, "parent event loop should keep ticking while worker is busy");
  });

  it("can detach fire-and-forget workers without changing the default", async () => {
    const workers = [];
    class FakeWorker extends EventEmitter {
      constructor(workerUrl, options) {
        super();
        this.workerUrl = workerUrl;
        this.options = options;
        this.unrefCalled = false;
        workers.push(this);
      }

      unref() {
        this.unrefCalled = true;
        return this;
      }

      terminate() {
        return Promise.resolve();
      }
    }

    const manager = new ThreadManager({ WorkerClass: FakeWorker });
    const firstRun = manager.run("fake-worker.mjs");
    assert.equal(workers[0].unrefCalled, false);
    workers[0].emit("message", { type: "result", result: { ok: "ref" } });
    assert.deepEqual(await firstRun, { ok: "ref" });

    const detachedRun = manager.run("fake-worker.mjs", { unref: true });
    assert.equal(workers[1].unrefCalled, true);
    workers[1].emit("message", { type: "result", result: { ok: "detached" } });
    assert.deepEqual(await detachedRun, { ok: "detached" });
  });
});
