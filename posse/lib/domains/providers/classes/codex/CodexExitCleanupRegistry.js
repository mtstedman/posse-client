export class CodexExitCleanupRegistry {
  constructor({ processRef = process } = {}) {
    this.processRef = processRef;
    this.cleanups = new Set();
    this.exitHandler = null;
  }

  register(cleanup) {
    if (typeof cleanup !== "function") return () => {};
    this.cleanups.add(cleanup);
    if (!this.exitHandler) {
      this.exitHandler = () => this.drain();
      this.processRef.once("exit", this.exitHandler);
    }
    return () => {
      this.cleanups.delete(cleanup);
      if (this.cleanups.size === 0 && this.exitHandler) {
        try { this.processRef.removeListener("exit", this.exitHandler); } catch { /* best effort */ }
        this.exitHandler = null;
      }
    };
  }

  drain() {
    const handler = this.exitHandler;
    const pending = [...this.cleanups];
    this.cleanups.clear();
    this.exitHandler = null;
    if (handler) {
      try { this.processRef.removeListener("exit", handler); } catch { /* best effort */ }
    }
    for (const cleanup of pending) {
      try { cleanup(); } catch { /* one cleanup must not block the rest */ }
    }
  }
}
