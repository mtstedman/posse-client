import { ThreadManager } from "../../../shared/concurrency/classes/ThreadManager.js";
import { gitCurrentHashAsync } from "../../git/functions/utils.js";

// Compiler subprocess waits must not block scheduler leases or native pulses.
export class ScopedCheckRunner {
  constructor({ threads = new ThreadManager(), getCommit = gitCurrentHashAsync } = {}) {
    this.threads = threads;
    this.getCommit = getCommit;
  }

  async run({ cwd, args = {}, declaredScope = {} } = {}) {
    let executedCommitHash = null;
    try { executedCommitHash = await this.getCommit(cwd); } catch { /* retain unavailable commit evidence */ }
    return this.threads.run(new URL("../functions/scoped-check-worker.js", import.meta.url), {
      label: "assessment scoped checks",
      workerData: { cwd, args, declaredScope, executedCommitHash },
    });
  }
}

export const scopedCheckRunner = new ScopedCheckRunner();
