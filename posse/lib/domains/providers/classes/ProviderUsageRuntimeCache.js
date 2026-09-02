export class ProviderUsageRuntimeCache {
  constructor({
    now = () => Date.now(),
    readSync = () => ({ summaries: [], currentRunProviderUsage: [] }),
    readAsync = async (opts) => readSync(opts),
  } = {}) {
    this.now = now;
    this.readSync = readSync;
    this.readAsync = readAsync;
    this.cache = { at: 0, summaries: [], currentRunProviderUsage: [] };
    this.refreshPromise = null;
    this.generation = 0;
  }

  configure({ now = null, readSync = null, readAsync = null } = {}) {
    if (typeof now === "function") this.now = now;
    if (typeof readSync === "function") this.readSync = readSync;
    if (typeof readAsync === "function") this.readAsync = readAsync;
  }

  // Drop the cached snapshot and any in-flight refresh. Primarily a test-isolation
  // hook: the cache is a process singleton, so without an explicit reset one test's
  // provider-usage snapshot (or an async refresh that resolves late) leaks into the
  // next test's render. Harmless in production, where it is simply never called.
  reset() {
    this.generation += 1;
    this.cache = { at: 0, summaries: [], currentRunProviderUsage: [] };
    this.refreshPromise = null;
  }

  _cloneSnapshot(snapshot = this.cache) {
    return {
      at: snapshot?.at || 0,
      summaries: Array.isArray(snapshot?.summaries)
        ? snapshot.summaries.map((entry) => ({ ...entry }))
        : [],
      currentRunProviderUsage: Array.isArray(snapshot?.currentRunProviderUsage)
        ? snapshot.currentRunProviderUsage.map((entry) => ({ ...entry }))
        : [],
    };
  }

  snapshot() {
    return this._cloneSnapshot();
  }

  _normalizeSnapshot(value) {
    return {
      at: this.now(),
      summaries: Array.isArray(value?.summaries) ? value.summaries : [],
      currentRunProviderUsage: Array.isArray(value?.currentRunProviderUsage)
        ? value.currentRunProviderUsage
        : [],
    };
  }

  refresh(opts = {}) {
    try {
      this.cache = this._normalizeSnapshot(this.readSync(opts) || {});
    } catch {
      // Keep the last good snapshot so rendering stays cheap and stable.
    }
    return this.snapshot();
  }

  async refreshAsync(opts = {}) {
    const generation = this.generation;
    try {
      const next = this._normalizeSnapshot(await this.readAsync(opts) || {});
      if (generation === this.generation) this.cache = next;
    } catch {
      // Keep the last good snapshot so rendering stays cheap and stable.
    }
    return this.snapshot();
  }

  async refreshIfChanged(opts = {}) {
    const before = JSON.stringify(this.cache);
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    this.refreshPromise = (async () => {
      let next;
      try {
        next = this._normalizeSnapshot(await this.readAsync(opts) || {});
      } catch {
        return false;
      }
      if (generation !== this.generation) return false;
      this.cache = next;
      return before !== JSON.stringify(this.cache);
    })();
    try {
      return await this.refreshPromise;
    } finally {
      if (generation === this.generation) this.refreshPromise = null;
    }
  }
}
