import { GIT_MUTATE_ROUTE, GIT_READ_ROUTE } from "../../../catalog/binary.js";
import { nativeBinaries } from "../../../shared/tools/classes/BinaryManager.js";
import { abortable } from "../../../shared/concurrency/functions/abortable.js";

// Serve needs no native Git until a clone joins. Warm the same grants the
// normal session bootstrap requires before its synchronous Git boundaries run.
export async function prepareServedHost({ signal, binaries = nativeBinaries } = {}) {
  const step = async (operation) => {
    signal?.throwIfAborted();
    return signal ? abortable(operation(), signal) : operation();
  };
  await step(() => binaries.startHeartbeat());
  const available = await step(() => binaries.ensureAvailable("git"));
  if (!available?.available) throw new Error(`posse-git unavailable (${available?.reason || "unknown"})`);
  await step(() => binaries.binary("git").ensureNativeAuth([GIT_READ_ROUTE, GIT_MUTATE_ROUTE]));
  const active = await step(() => binaries.ensureActive("git"));
  if (!active?.active) throw new Error(`posse-git inactive (${active?.reason || "unknown"})`);
}
