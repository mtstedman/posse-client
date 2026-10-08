// @ts-check

// A single read's memoized inputs. Never shared across requests or writer gates.
export class SymbolReadRequest {
  constructor({ view, readFile = (_file) => null, now = () => performance.now() }) {
    this.now = now;
    this.workMs = { resolution: 0, declaration_proof: 0, body_resolution: 0, render: 0, query: 0, source: 0 };
    this.counts = { queries: 0, query_hits: 0, source_reads: 0, source_hits: 0 };
    const queries = new Map();
    const sources = new Map();
    const methods = new Map();
    // These are immutable indexed read results for the duration of this read.
    // Each consumer gets its own rows because selectors may sort/filter them.
    const memoized = new Set(["findSymbol", "symbolsInFile", "getAllByContentLocal"]);
    // Forward through facades: native query APIs are frozen, so proxying them
    // directly cannot replace their non-configurable methods with cache wrappers.
    const queryTarget = view.query;
    const query = new Proxy(Object.create(queryTarget), {
      get: (_target, key) => {
        const target = queryTarget;
        const method = Reflect.get(target, key, target);
        if (typeof method !== "function") return method;
        if (!methods.has(key)) methods.set(key, typeof key === "string" && memoized.has(key) ? async (...args) => {
          const cacheKey = JSON.stringify([key, args]);
          if (queries.has(cacheKey)) this.counts.query_hits++;
          else {
            this.counts.queries++;
            queries.set(cacheKey, this.measure("query", () => method.apply(target, args)));
          }
          return structuredClone(await queries.get(cacheKey));
        } : method.bind(target));
        return methods.get(key);
      },
    });
    this.view = new Proxy(Object.create(view), {
      get: (_target, key) => {
        const target = view;
        if (key === "query") return query;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.readFile = (file) => {
      if (sources.has(file)) {
        this.counts.source_hits++;
        return sources.get(file);
      }
      this.counts.source_reads++;
      const started = now();
      try {
        const source = readFile(file);
        sources.set(file, source);
        return source;
      } finally {
        this.workMs.source += Math.max(0, now() - started);
      }
    };
  }

  async measure(stage, fn) {
    const started = this.now();
    try { return await fn(); }
    finally { this.workMs[stage] += Math.max(0, this.now() - started); }
  }

  diagnostics() {
    // Stages nest and batch children overlap: these are work sums, not wall time.
    return { work_ms: { ...this.workMs }, counts: { ...this.counts } };
  }
}
