import { baselineCheckIdentity, baselineCheckStillMatches, readBaselineCheck, storeBaselineCheck, reusableBaselineCheck } from "../../verification/functions/baseline-check-evidence.js";

// Shared in-memory within a batch and durable across plans/restarts. Post-change
// verification never reads this cache; only baseline collection may reuse it.
export class PlanBaselineChecks {
  #results = new Map();

  async run(check, { cwd, policy, signal }, execute) {
    signal?.throwIfAborted();
    const identity = baselineCheckIdentity(check, { cwd, policy });
    const prior = identity && (this.#results.get(identity.key) || readBaselineCheck(identity));
    if (prior) {
      const reused = { ...structuredClone(prior), duration_ms: 0, baseline_shared: true };
      // Never claim that the first selected file was the second consumer's
      // selection, or that the section failure belongs to either named file.
      if (check.unit_test_paths?.length === 1 && reused.file_results?.length === 1) {
        reused.file_results[0].path = check.unit_test_paths[0];
        reused.file_results[0].selected_path = check.unit_test_paths[0];
      }
      return reused;
    }
    const result = await execute();
    signal?.throwIfAborted();
    if (identity && reusableBaselineCheck(result)
      && baselineCheckStillMatches(identity, check, { cwd, policy })) {
      const artifact = storeBaselineCheck(identity, result);
      this.#results.set(identity.key, { ...structuredClone(result), baseline_source_artifact_id: artifact?.id });
    }
    return result;
  }
}
