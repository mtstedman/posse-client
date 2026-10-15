import { TEST_FAILURE_GUIDANCE } from "../../../catalog/unit-test-runner.js";

/** One notice per Agent call, shared across test paths within its toolkit. */
export class TestFailureGuidance {
  #issued = new Set();

  forResult(result, callId = null) {
    if (result?.outcome === "passed") return null;
    const key = callId ?? "toolkit";
    if (this.#issued.has(key)) return null;
    this.#issued.add(key);
    return TEST_FAILURE_GUIDANCE;
  }
}
