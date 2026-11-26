import { environmentFilesFingerprint, porcelain } from "../../verification/functions/receipt-fingerprint.js";
import { describeToolchain, toolchainFingerprint } from "../../settings/functions/verification-policy.js";

// Scoped to one detached, pinned baseline checkout. Never used by post-change
// verification. Only conclusive executions on clean inputs can be shared.
export class PlanBaselineChecks {
  #results = new Map();

  async run(check, { cwd, policy, signal }, execute) {
    signal?.throwIfAborted();
    const environment = environmentFilesFingerprint(cwd);
    const clean = await porcelain(cwd) === "";
    const key = JSON.stringify([check.unit_test_paths ? null : check.execution_command || check.command, check.cwd_relative || null,
      check.unit_test_paths || null, check.intent || "test", check.source === "task_ab_acceptance",
      policy.fingerprint, policy.wall_timeout_ms, policy.idle_timeout_ms,
      toolchainFingerprint(describeToolchain({ projectDir: cwd })), environment]);
    const prior = clean && environment && this.#results.get(key);
    if (prior) return { ...structuredClone(prior), duration_ms: 0, baseline_shared: true };
    const result = await execute();
    signal?.throwIfAborted();
    if (clean && environment && ["passed", "failed"].includes(result.status)
      && !result.timed_out && !result.signal && !result.stdout_truncated && !result.stderr_truncated
      && await porcelain(cwd) === "" && environmentFilesFingerprint(cwd) === environment) {
      this.#results.set(key, structuredClone(result));
    }
    return result;
  }
}
