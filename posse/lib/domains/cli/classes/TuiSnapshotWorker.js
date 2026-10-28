import { nativeWorkerSettings } from "../../../shared/native/functions/worker-settings.js";
import { Worker } from "node:worker_threads";
import { threadLifetimeRegistry } from "../../../shared/concurrency/classes/ThreadLifetimeRegistry.js";
import { errorFromThreadPayload } from "../../../shared/concurrency/classes/ThreadManager.js";
import { sanitizeWorkerExecArgv } from "../../runtime/functions/worker-exec-argv.js";

// One run owns one database-bound worker. Serialize requests so imports and
// database handles can be reused without overlapping snapshot queries.
export class TuiSnapshotWorker {
  constructor({ projectDir, dbPath, timeoutMs = 5000, WorkerClass = Worker,
    workerUrl = new URL("../functions/tui-snapshot-worker.js", import.meta.url) } = {}) {
    this.args = { projectDir, dbPath };
    this.timeoutMs = timeoutMs;
    this.WorkerClass = WorkerClass;
    this.workerUrl = workerUrl;
    this.worker = null;
    this.pending = null;
    this.sequence = 0;
    this.closed = false;
    this.queue = Promise.resolve();
    this.retiring = Promise.resolve();
  }

  run(task) {
    const result = this.queue.then(() => this.execute(task));
    this.queue = result.catch(() => {});
    return result;
  }

  async execute(task) {
    await this.retiring;
    if (this.closed) throw new Error("TUI snapshot worker stopped");
    if (!this.worker) this.start();
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        void this.retire(worker, new Error(`TUI ${task} snapshot timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending = { id, resolve, reject, timer };
      worker.ref();
      try { worker.postMessage({ id, task }); }
      catch (err) { void this.retire(worker, err); }
    });
  }

  start() {
    const lifetime = threadLifetimeRegistry.reserve();
    let worker;
    try {
      worker = new this.WorkerClass(this.workerUrl, {
        execArgv: sanitizeWorkerExecArgv(),
        workerData: {
        ...nativeWorkerSettings(this.args?.projectDir || process.cwd()), args: this.args, posseThreadLifetime: lifetime },
      });
    } catch (err) {
      threadLifetimeRegistry.retire(lifetime);
      throw err;
    }
    this.worker = worker;
    worker.on("message", (message) => {
      const pending = this.pending;
      if (worker !== this.worker || !pending || pending.id !== message?.id) return;
      if (message.type !== "result" && message.type !== "error") return;
      clearTimeout(pending.timer);
      this.pending = null;
      worker.unref();
      if (message.type === "error") pending.reject(errorFromThreadPayload(message.error));
      else pending.resolve(message.result);
    });
    worker.on("error", (err) => { void this.retire(worker, err); });
    worker.once("exit", (code) => {
      threadLifetimeRegistry.retire(lifetime);
      void this.retire(worker, new Error(`TUI snapshot worker exited with code ${code}`));
    });
    worker.unref();
  }

  retire(worker, error) {
    if (!worker || worker !== this.worker) return this.retiring;
    this.worker = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) clearTimeout(pending.timer);
    // Keep the error listener until exit; a late worker error must not become
    // an unhandled EventEmitter error while termination is in progress.
    this.retiring = worker.terminate().catch(() => {}).then(() => {
      worker.removeAllListeners();
      pending?.reject(error);
    });
    return this.retiring;
  }

  async stop() {
    this.closed = true;
    await this.retire(this.worker, new Error("TUI snapshot worker stopped"));
    await this.queue;
  }
}
