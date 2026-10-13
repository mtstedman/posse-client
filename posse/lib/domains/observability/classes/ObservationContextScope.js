import { AsyncLocalStorage } from "node:async_hooks";

// One context owner for recording and projection. Concurrent agent calls must
// share the owner, while retaining their own async scope and attribution.
export class ObservationContextScope {
  constructor() {
    this.storage = new AsyncLocalStorage();
  }

  run(context, fn) {
    return this.storage.run(context, fn);
  }

  enterWith(context) {
    this.storage.enterWith(context);
  }

  getStore() {
    return this.storage.getStore();
  }
}

export const observationContextScope = new ObservationContextScope();
