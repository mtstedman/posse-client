import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting } from "../../../domains/queue/functions/index.js";

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export class RetryPolicy {
  constructor({
    maxAttempts = 3,
    baseBackoffSec = 30,
    capBackoffSec = 300,
  } = {}) {
    this.maxAttempts = asPositiveInt(maxAttempts, 3);
    this.baseBackoffSec = asPositiveInt(baseBackoffSec, 30);
    this.capBackoffSec = asPositiveInt(capBackoffSec, 300);
    Object.freeze(this);
  }

  shouldRetry(attemptCount = 0) {
    const attempt = Math.max(0, Number(attemptCount) || 0);
    return attempt < this.maxAttempts;
  }

  backoffFor(attemptCount = 1) {
    const attempt = Math.max(1, Number(attemptCount) || 1);
    const computed = this.baseBackoffSec * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(this.capBackoffSec, Math.max(this.baseBackoffSec, Math.floor(computed)));
  }

  escalateTier(currentTier = "standard", attemptCount = 1) {
    const tier = String(currentTier || "standard");
    const attempt = Math.max(1, Number(attemptCount) || 1);
    if (attempt >= 3) return "strong";
    if (attempt >= 2 && tier === "cheap") return "standard";
    return tier;
  }

  static fromSettings() {
    let maxAttempts = 3;
    try {
      maxAttempts = asPositiveInt(getSetting(SETTING_KEYS.DEFAULT_MAX_ATTEMPTS), 3);
    } catch {
      maxAttempts = 3;
    }
    return new RetryPolicy({ maxAttempts });
  }

  static fromJob(job = {}) {
    return new RetryPolicy({
      maxAttempts: job?.max_attempts ?? job?.maxAttempts ?? RetryPolicy.fromSettings().maxAttempts,
    });
  }
}
