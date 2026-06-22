import { classifyProviderError } from "../shared/api-resilience.js";

export function classifyCopilotFailure({ stdout = "", stderr = "", exit = 1, acc = null } = {}) {
  const combined = `${stdout}\n${stderr}`;
  if (/Access denied by policy settings/i.test(combined)) {
    return {
      code: "COPILOT_POLICY_BLOCKED",
      message: "Copilot CLI policy denies agent execution. Check https://github.com/settings/copilot or your org admin.",
      tripRateLimit: { backoffSec: 3600, reason: "policy_blocked" },
    };
  }
  if (/quota[^a-z]/i.test(combined) || /rate limit/i.test(combined) || /premium request/i.test(combined)) {
    return {
      code: "COPILOT_QUOTA_EXHAUSTED",
      message: "Copilot subscription quota exhausted or rate-limited.",
      tripRateLimit: { backoffSec: 900, reason: "quota_exhausted" },
    };
  }
  if (/unauthorized|invalid (?:token|credentials)|authentication required/i.test(combined)) {
    return {
      code: "COPILOT_AUTH_FAILED",
      message: "Copilot CLI rejected the credential. Run `copilot login` or refresh GH_TOKEN.",
      tripRateLimit: { backoffSec: 600, reason: "auth_failed" },
    };
  }
  if (acc?.errors?.length > 0) {
    const first = acc.errors[0];
    return {
      code: `COPILOT_${String(first.type || "ERROR").toUpperCase()}`,
      message: first.message || `Copilot CLI exited with code ${exit}`,
    };
  }
  return {
    code: "COPILOT_NONZERO_EXIT",
    message: `Copilot CLI exited with code ${exit}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`,
  };
}

export function parseCopilotErrorBackoff(err) {
  return classifyProviderError(err, { defaultBackoffSec: 30 });
}
