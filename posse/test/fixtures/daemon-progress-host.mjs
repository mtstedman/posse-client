// Test fixture: a thread daemon host that streams N progress events before
// returning its terminal result. Exercises the Daemon progress channel.
import { runDaemonThread } from "../../lib/classes/tools/daemon/thread-host.js";

runDaemonThread(async (payload, _message, emitProgress) => {
  const count = Number(/** @type {any} */ (payload)?.count) || 0;
  for (let i = 1; i <= count; i++) emitProgress({ step: i });
  return { steps: count, echo: /** @type {any} */ (payload)?.echo ?? null };
});
