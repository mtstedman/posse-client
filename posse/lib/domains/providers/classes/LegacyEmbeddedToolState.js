// @ts-check
// Compatibility execution only. Production tools are owned by the MCP owner.
import { AsyncResourceGate } from "../../../shared/concurrency/classes/AsyncGate.js";
import { awaitJobScopeExpansionDecision } from "../../queue/functions/index.js";

export class LegacyEmbeddedToolState {
  gate = new AsyncResourceGate({ name: "provider native tool" });
  #scopeWaits = new Map();

  waitForScopeDecision({ jobId, requestId, attemptId, signal }) {
    const key = `${jobId}:${requestId}`;
    const existing = this.#scopeWaits.get(key);
    if (existing) return existing;
    const wait = awaitJobScopeExpansionDecision({ jobId, requestId, attemptId, signal })
      .finally(() => {
        if (this.#scopeWaits.get(key) === wait) this.#scopeWaits.delete(key);
      });
    this.#scopeWaits.set(key, wait);
    return wait;
  }
}

export const legacyEmbeddedToolState = new LegacyEmbeddedToolState();
