// @ts-check
//
// Broker worker for blocking daemon access. The main thread can't do blocking
// I/O against a child process, so this worker thread owns a Daemon over a
// ProcessTransport and answers blocking requests over a SyncChannel: the main
// thread posts a request + blocks on Atomics; we run the async daemon round-trip
// here and write the response back into the shared buffer.
//
// Reused for any process-backed daemon (git, atlas) — the transport spec is
// passed in via workerData so the same broker serves every binary.

import { parentPort, workerData } from "node:worker_threads";
import { Daemon } from "./Daemon.js";
import { ProcessTransport } from "./transport.js";
import { bindSyncChannel, channelRespond } from "./sync-channel.js";

const { shared, transportSpec } = workerData;
const { control, data } = bindSyncChannel(shared);

const daemon = new Daemon({
  transportFactory: () => ProcessTransport({
    resolveBin: () => transportSpec.binPath,
    buildArgs: () => transportSpec.args || [],
    // Inherit the worker thread's env snapshot (carries heartbeat config).
    env: () => process.env,
  }),
  timeoutMs: transportSpec.timeoutMs ?? 0,
});

parentPort?.on("message", async (payload) => {
  let response;
  try {
    response = await daemon.request(payload, {});
  } catch (err) {
    response = { ok: false, error: { message: String(err?.message || err) } };
  }
  channelRespond(control, data, response);
});
