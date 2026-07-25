import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getLiveSchedulerBlockMessage } from "../../queue/functions/index.js";

const ORCHESTRATOR_PATH = fileURLToPath(
  new URL("../../../../orchestrator.js", import.meta.url),
);
const RECENT_LAUNCH_WINDOW_MS = 15_000;

/**
 * Starts the repo's normal `posse go` workflow without tying its lifetime to
 * the bridge process. The scheduler lock remains the authoritative duplicate
 * runner guard; the short local window closes the gap before that lock lands.
 */
export class PosseRunLauncher {
  constructor({
    projectDir = process.cwd(),
    spawnImpl = spawn,
    execPath = process.execPath,
    orchestratorPath = ORCHESTRATOR_PATH,
    now = () => Date.now(),
  } = {}) {
    this.projectDir = projectDir;
    this.spawnImpl = spawnImpl;
    this.execPath = execPath;
    this.orchestratorPath = orchestratorPath;
    this.now = now;
    this.lastLaunchAt = 0;
    this.launchPromise = null;
  }

  start() {
    const liveScheduler = getLiveSchedulerBlockMessage("main");
    if (liveScheduler) {
      return Promise.resolve({
        started: false,
        already_running: true,
      });
    }
    if (
      this.launchPromise ||
      this.now() - this.lastLaunchAt < RECENT_LAUNCH_WINDOW_MS
    ) {
      return this.launchPromise ?? Promise.resolve({
        started: false,
        already_starting: true,
      });
    }

    this.launchPromise = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnImpl(
          this.execPath,
          [
            this.orchestratorPath,
            "go",
            "--non-interactive",
            "--no-tui",
          ],
          {
            cwd: this.projectDir,
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          },
        );
      } catch (err) {
        reject(err);
        return;
      }

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      child.once?.("error", fail);
      child.once?.("spawn", () => {
        if (settled) return;
        settled = true;
        this.lastLaunchAt = this.now();
        child.unref?.();
        resolve({ started: true });
      });
    }).finally(() => {
      this.launchPromise = null;
    });

    return this.launchPromise;
  }
}
