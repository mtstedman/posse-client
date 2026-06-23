// lib/domains/providers/functions/codex/errors.js

import { extractJson } from "../../../../shared/format/functions/json.js";
import { providerRuntimeState } from "../../classes/runtime-state-singleton.js";
import { escalateModelTier } from "../shared/turns.js";
import { classifyProviderError } from "../shared/api-resilience.js";

export function escalateTier(currentTier, attemptCount, options = {}) {
  return escalateModelTier(currentTier, attemptCount, options);
}

export { extractJson };

export function tripRateLimit(backoffSec, reason = "") {
  providerRuntimeState.tripRateLimit("codex", backoffSec, reason);
}

export function getRateLimitState() {
  return providerRuntimeState.getRateLimitState("codex");
}

export function parseErrorBackoff(err) {
  return classifyProviderError(err, { defaultBackoffSec: 15 });
}

export function isCodexResumeHandleExpiredError(text) {
  return /no\s+(?:session|conversation|thread|resume)(?:\s+\w+)*\s+found|(?:session|conversation|thread|resume).*(?:not\b.*\bfound|unknown|invalid|expired|no\s+such)|(?:not\b.*\bfound|unknown|invalid|expired|no\s+such).*(?:session|conversation|thread|resume)/i
    .test(String(text || ""));
}
