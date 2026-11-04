import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getLiveSchedulerBlockMessage } from "../../queue/functions/index.js";
import { EVENT_TYPES } from "../../../catalog/event.js";
import { environmentForNewRun } from "../../../shared/telemetry/functions/run-env.js";

const ORCHESTRATOR_PATH = fileURLToPath(
  new URL("../../../../orchestrator.js", import.meta.url),
);
// Older phones allow 15 seconds for run.start. A slow boot acknowledges
// pending startup within that budget; the event stream supplies readiness.
const STARTUP_WAIT_MS = 10_000;

/**
 * Starts the repo's normal `posse go` workflow without tying its lifetime to
 * the bridge process. The scheduler lock remains the authoritative duplicate
 * runner guard. A spawn is only an attempt: acknowledge startup when this
 * child publishes its scheduler-ready message, and retain ownership through wrap-up.
 */
export class PosseRunLauncher {
  constructor({
    projectDir = process.cwd(),
    spawnImpl = spawn,
    execPath = process.execPath,
    orchestratorPath = ORCHESTRATOR_PATH,
    startupWaitMs = STARTUP_WAIT_MS,
  } = {}) {
    this.projectDir = projectDir;
    this.spawnImpl = spawnImpl;
    this.execPath = execPath;
    this.orchestratorPath = orchestratorPath;
    this.startupWaitMs = startupWaitMs;
    this.child = null;
    this.childReady = false;
    this.launchPromise = null;
  }

  start() {
    if (this.launchPromise) return this.launchPromise;
    if (this.child && !this.childReady) {
      return Promise.resolve({ started: false, already_starting: true });
    }
    const liveScheduler = getLiveSchedulerBlockMessage("main");
    if (liveScheduler) {
      return Promise.resolve({
        started: false,
        already_running: true,
      });
    }
    // The scheduler lock has gone but the child is still wrapping up (merging,
    // offering a push). Only a ready child reaches here: a pending one answered above.
    if (this.child) {
      return Promise.resolve({ ok: false, reason: "run_finishing", started: false });
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
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
            env: environmentForNewRun(),
          },
        );
      } catch (err) {
        reject(err);
        return;
      }

      this.child = child;
      this.childReady = false;
      let settled = false;
      let timeoutTimer;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        resolve(result);
      };
      const disconnect = () => {
        try { if (child.connected) child.disconnect(); } catch { /* child exited */ }
      };
      const onReady = (message) => {
        if (message?.type !== EVENT_TYPES.SCHEDULER_STARTED || message.process_pid !== child.pid) return;
        this.childReady = true;
        settle({ started: true });
        disconnect();
      };
      child.on("message", onReady);
      const finish = (code, signal) => {
        child.off("message", onReady);
        disconnect();
        clearTimeout(timeoutTimer);
        if (this.child === child) {
          this.child = null;
          this.childReady = false;
        }
        settle({ ok: false, reason: "run_start_failed", started: false,
          exit_code: code ?? null, signal: signal ?? null });
      };
      child.once("error", () => finish(null, null));
      child.once("exit", finish);
      child.once("spawn", () => {
        child.unref?.();
        child.channel?.unref?.();
        // Keep observing after the acknowledgment deadline. A slow child
        // remains owned, so another tap cannot launch a duplicate process.
        timeoutTimer = setTimeout(() => {
          settle({ started: false, already_starting: true });
        }, this.startupWaitMs);
      });
    }).finally(() => {
      this.launchPromise = null;
    });

    return this.launchPromise;
  }
}
