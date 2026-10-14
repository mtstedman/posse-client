import { PAIRING_GIT_TIMEOUT_ENV, PAIRING_GIT_MAX_TIMEOUT_MS, PAIRING_GIT_OPERATION_TIMEOUTS } from "../../../catalog/pairing-environment.js";

// Keep cheap metadata probes bounded separately from transfers and worktree
// traversal. Read the override at call time, including on a retried pairing.
export function pairingGitTimeoutMs(operation, requested = 60_000, env = process.env) {
  const override = Number(env[PAIRING_GIT_TIMEOUT_ENV]);
  const minimum = Math.max(requested, PAIRING_GIT_OPERATION_TIMEOUTS[operation] || requested);
  const budget = Number.isSafeInteger(override) && override > 0
    ? Math.max(minimum, override) : minimum;
  return Math.min(PAIRING_GIT_MAX_TIMEOUT_MS, budget);
}
