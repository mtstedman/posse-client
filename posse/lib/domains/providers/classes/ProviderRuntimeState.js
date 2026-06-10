export class ProviderRuntimeState {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.rateLimits = new Map();
    this.usageAuthPrimed = false;
  }

  _providerKey(providerName) {
    return String(providerName || "").trim().toLowerCase() || "unknown";
  }

  tripRateLimit(providerName, backoffSec, reason = "") {
    const key = this._providerKey(providerName);
    const sec = Math.max(0, Number(backoffSec) || 0);
    if (sec <= 0) {
      this.rateLimits.delete(key);
      return;
    }
    const until = this.now() + sec * 1000;
    const current = this.rateLimits.get(key) || { until: 0, reason: "" };
    if (until > current.until) {
      this.rateLimits.set(key, { until, reason: String(reason || "") });
    }
  }

  getRateLimitState(providerName) {
    const key = this._providerKey(providerName);
    const current = this.rateLimits.get(key) || { until: 0, reason: "" };
    const remaining = current.until - this.now();
    if (remaining <= 0) {
      this.rateLimits.delete(key);
      return { blocked: false, retryInSec: 0, reason: "" };
    }
    return {
      blocked: true,
      retryInSec: Math.ceil(remaining / 1000),
      reason: current.reason,
    };
  }

  resetRateLimit(providerName = null) {
    if (providerName == null) {
      this.rateLimits.clear();
      return;
    }
    this.rateLimits.delete(this._providerKey(providerName));
  }

  isUsageAuthPrimed() {
    return this.usageAuthPrimed;
  }

  markUsageAuthPrimed(value = true) {
    this.usageAuthPrimed = !!value;
  }

  resetUsageAuthPrime() {
    this.usageAuthPrimed = false;
  }
}
