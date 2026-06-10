// test/test-daemon-progress-channel.test.js
//
// The Daemon progress channel: a thread host can stream `{ id, progress }`
// messages mid-request; the Daemon routes them to the caller's onProgress and
// still resolves with the terminal `{ ok, data }`. Backward compatible — a
// request without onProgress just ignores the progress messages.

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, ThreadTransport } from "../lib/classes/tools/daemon/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_URL = new URL("./fixtures/daemon-progress-host.mjs", import.meta.url);

function makeDaemon() {
  return new Daemon({ transportFactory: () => ThreadTransport({ moduleUrl: HOST_URL }) });
}

describe("Daemon progress channel", () => {
  /** @type {Daemon[]} */
  const open = [];
  after(async () => { for (const d of open) { try { await d.dispose(); } catch { /* ignore */ } } });

  it("streams progress events in order and still resolves the terminal result", async () => {
    const daemon = makeDaemon();
    open.push(daemon);
    const progress = [];
    const res = await daemon.request({ count: 3, echo: "hi" }, { onProgress: (e) => progress.push(e) });
    assert.equal(res.ok, true);
    assert.deepEqual(res.data, { steps: 3, echo: "hi" });
    assert.deepEqual(progress, [{ step: 1 }, { step: 2 }, { step: 3 }]);
  });

  it("works without onProgress (progress messages are ignored)", async () => {
    const daemon = makeDaemon();
    open.push(daemon);
    const res = await daemon.request({ count: 2 });
    assert.equal(res.ok, true);
    assert.equal(res.data.steps, 2);
  });

  it("routes progress to the right request under concurrency", async () => {
    const daemon = makeDaemon();
    open.push(daemon);
    const a = [];
    const b = [];
    const [ra, rb] = await Promise.all([
      daemon.request({ count: 2, echo: "a" }, { onProgress: (e) => a.push(e) }),
      daemon.request({ count: 4, echo: "b" }, { onProgress: (e) => b.push(e) }),
    ]);
    assert.equal(ra.data.echo, "a");
    assert.equal(rb.data.echo, "b");
    assert.equal(a.length, 2, "request a got its own 2 progress events");
    assert.equal(b.length, 4, "request b got its own 4 progress events");
  });

  it("disposes cleanly (process can exit)", async () => {
    const daemon = makeDaemon();
    await daemon.request({ count: 1 }, { onProgress: () => {} });
    await daemon.dispose(); // awaiting terminate releases the worker MessagePort
    assert.ok(true);
  });
});
