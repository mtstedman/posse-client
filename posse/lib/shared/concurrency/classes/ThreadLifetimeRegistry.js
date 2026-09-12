// Shared lifetime slots are retired only by the parent's Worker exit event.
// Reuse advances a generation, so stale lock files cannot name a new owner.
import { getEnvironmentData, setEnvironmentData, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";

const KEY = "posse.thread-liveness.v1";

export class ThreadLifetimeRegistry {
  constructor() {
    this.registry = getEnvironmentData(KEY) || {
      id: randomUUID(), states: new SharedArrayBuffer(4096),
    };
    setEnvironmentData(KEY, this.registry);
    this.states = new Int32Array(this.registry.states);
  }

  reserve() {
    for (let slot = 0; slot < this.states.length; slot++) {
      const previous = Atomics.load(this.states, slot);
      if (previous > 0 || previous === -2147483647) continue;
      const generation = Math.abs(previous) + 1;
      if (Atomics.compareExchange(this.states, slot, previous, generation) === previous) {
        return { registry: this.registry.id, slot, generation };
      }
    }
    return null; // Unknown owners are never reclaimed on an age guess.
  }

  retire(lifetime) {
    if (lifetime?.registry !== this.registry.id) return;
    Atomics.compareExchange(this.states, lifetime.slot, lifetime.generation, -lifetime.generation);
  }

  current() {
    return workerData?.posseThreadLifetime || null;
  }

  hasExited(lifetime) {
    if (lifetime?.registry !== this.registry.id
      || !Number.isInteger(lifetime.slot) || lifetime.slot < 0 || lifetime.slot >= this.states.length
      || !Number.isInteger(lifetime.generation) || lifetime.generation <= 0) return false;
    const state = Atomics.load(this.states, lifetime.slot);
    return state === -lifetime.generation || Math.abs(state) > lifetime.generation;
  }
}

export const threadLifetimeRegistry = new ThreadLifetimeRegistry();
