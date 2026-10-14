import { receiveMessageOnPort } from "node:worker_threads";

/** Drain synchronously: message callbacks cannot run during spawnSync. */
export function latestWorkerPulses(port) {
  if (!port) return null;
  let latest = null;
  for (let message = receiveMessageOnPort(port); message; message = receiveMessageOnPort(port)) {
    latest = message.message;
  }
  return latest;
}
