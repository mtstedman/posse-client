// @ts-check

import { parentPort, workerData } from "worker_threads";

import { doctorRepoDependencies, ensureBootDependencies } from "./dependency-sync.js";

function post(message) {
  try { parentPort?.postMessage(message); } catch { /* worker is exiting */ }
}

function serializeError(err) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err),
    stack: err?.stack || null,
    code: err?.code || null,
  };
}

try {
  const input = { ...(workerData || {}) };
  const run = input.doctor === true ? doctorRepoDependencies : ensureBootDependencies;
  delete input.doctor;
  const result = await run({
    ...input,
    onProgress: (message) => post({
      type: "progress",
      event: { message: String(message || "") },
    }),
  });
  post({ type: "result", result });
} catch (err) {
  post({ type: "error", error: serializeError(err) });
}
