import { spawn } from "node:child_process";
import {
  recordDaemonSpawn,
  forgetDaemonSpawn,
} from "../../tools/classes/daemon/process-ledger.js";

/**
 * Best-effort cross-platform termination for a spawned process tree.
 * POSIX callers must launch the child detached so its pid is also the process
 * group id. Windows uses taskkill's tree traversal.
 */
export function terminateSpawnedProcessTree(proc, {
  force = false,
  platform = process.platform,
  processGroup = false,
} = {}) {
  const pid = Number(proc?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  if (platform === "win32") {
    try {
      const args = ["/pid", String(pid), "/T"];
      if (force) args.push("/F");
      const killer = spawn("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.unref?.();
      return true;
    } catch {
      // Fall through to direct-child termination.
    }
  } else if (processGroup) {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      // Fall through to direct-child termination.
    }
  }

  if (proc.exitCode != null || (!force && proc.killed)) return false;
  try {
    return proc.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    return false;
  }
}

export function trackSpawnedProcess(proc, bin, context = {}) {
  const pid = Number(proc?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return () => {};
  recordDaemonSpawn(pid, bin, context);
  let done = false;
  const forget = () => {
    if (done) return;
    done = true;
    forgetDaemonSpawn(pid);
  };
  try { proc.once?.("close", forget); } catch {}
  try { proc.once?.("exit", forget); } catch {}
  try { proc.once?.("error", forget); } catch {}
  return forget;
}
