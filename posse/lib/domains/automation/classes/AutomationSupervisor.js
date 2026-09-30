import fs from "node:fs";
import { spawn } from "node:child_process";
import { AutomationOwnerClient } from "./AutomationOwnerClient.js";
import { AUTOMATION_OWNER_ENTRY } from "../functions/paths.js";
import { AUTOMATION_OWNER_LAUNCH } from "../../../catalog/custom-tools.js";

// An owner that stayed up this long was working, not failing at start-up.
export const AUTOMATION_SUPERVISOR_FAST_FAILURE_MS = 30_000;
// Consecutive start-up failures before the supervisor gives up. The capped
// backoff between them spans about a minute, longer than the dispatcher
// lease a crashed owner can leave behind.
export const AUTOMATION_SUPERVISOR_MAX_FAST_FAILURES = 8;
const MAX_BACKOFF_MS = 30_000;

// Keeps one owner process alive. It stops when told to, when another owner
// is serving, when its owner entry file no longer exists (the checkout was
// removed), or after repeated start-up failures.
export class AutomationSupervisor {
  constructor({
    ownerEntry = AUTOMATION_OWNER_ENTRY,
    launch = AUTOMATION_OWNER_LAUNCH.SERVICE,
    env = process.env,
    spawnOwner = null,
    ownerReady = null,
    entryExists = fs.existsSync,
    now = Date.now,
    maxFastFailures = AUTOMATION_SUPERVISOR_MAX_FAST_FAILURES,
    fastFailureMs = AUTOMATION_SUPERVISOR_FAST_FAILURE_MS,
  } = {}) {
    this.ownerEntry = ownerEntry; this.launch = launch; this.env = env;
    this.spawnOwner = spawnOwner || (() => spawn(process.execPath, [this.ownerEntry], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...this.env, POSSE_AUTOMATION_SUPERVISOR_PID: String(process.pid), POSSE_AUTOMATION_LAUNCH: this.launch },
    }));
    this.ownerReady = ownerReady || defaultOwnerReady;
    this.entryExists = entryExists; this.now = now;
    this.maxFastFailures = maxFastFailures; this.fastFailureMs = fastFailureMs;
    this.stopping = false; this.child = null; this.wake = null;
  }

  stop(signal = "SIGTERM") {
    this.stopping = true;
    try { this.child?.kill(signal); } catch {}
    this.wake?.();
  }

  async run() {
    let failures = 0;
    while (!this.stopping) {
      if (!this.entryExists(this.ownerEntry)) return "owner_entry_missing";
      const startedAt = this.now();
      const child = this.spawnOwner();
      this.child = child;
      await new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
      this.child = null;
      if (this.stopping) break;
      if (await this.ownerReady()) return "owner_ready";
      const fast = this.now() - startedAt < this.fastFailureMs;
      failures = fast ? failures + 1 : 1;
      if (fast && failures >= this.maxFastFailures) return "gave_up";
      await this.sleep(Math.min(MAX_BACKOFF_MS, 250 * 2 ** Math.min(failures, 7)));
    }
    return "stopped";
  }

  sleep(ms) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.wake = null; resolve(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

async function defaultOwnerReady() {
  try { return (await new AutomationOwnerClient({ timeoutMs: 300 }).health())?.ready === true; } catch { return false; }
}
