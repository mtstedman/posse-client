import { MessageChannel } from "node:worker_threads";

/** Keep a synchronous worker supplied with parent-minted grants while it blocks
 * in long verification subprocesses. The parent never replays worker actions. */
export class WorkerPulseLease {
  constructor(binary, routes) {
    this.binary = binary;
    this.routes = routes;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.workerPort = port2;
    this.stopped = false;
    this.timer = null;
  }

  start(pulses) {
    if (this.stopped) return;
    const next = Math.min(...Object.values(pulses || {}).map((pulse) =>
      Number(pulse.refreshAfter || pulse.expiresAt - 15) * 1000));
    const delay = Number.isFinite(next) ? Math.max(1000, next - Date.now()) : 1000;
    this.timer = setTimeout(() => { void this.refresh(); }, delay);
    this.timer.unref?.();
  }

  async refresh() {
    if (this.stopped) return;
    let pulses = {};
    try {
      pulses = await this.binary.workerPulseCapability(this.routes, { strict: true });
      if (!this.stopped) this.port.postMessage(pulses);
    } catch { /* Keep valid grants; expiry still fails closed in the worker. */ }
    this.start(pulses);
  }

  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.port.close();
    this.workerPort.close();
  }
}

