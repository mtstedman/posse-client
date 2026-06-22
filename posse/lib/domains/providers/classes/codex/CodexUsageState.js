import { log } from "../../../../shared/telemetry/functions/logging/logger.js";

function firstErrorLine(err) {
  return String(err?.message || err || "unknown").split("\n")[0].trim();
}

export class CodexUsageState {
  constructor({
    cacheMs = () => 0,
    backoffMs = () => 0,
    cloneUsageSummary = (summary) => summary,
    logger = log,
  } = {}) {
    this.cacheMs = typeof cacheMs === "function" ? cacheMs : () => 0;
    this.backoffMs = typeof backoffMs === "function" ? backoffMs : () => 0;
    this.cloneUsageSummary = typeof cloneUsageSummary === "function"
      ? cloneUsageSummary
      : (summary) => summary;
    this.logger = logger;
    this.reset();
  }

  reset() {
    this.usageSummaryCache = null;
    this.interactiveUsageUnavailableReason = null;
    this.testFetchCodexStatusViaInteractive = null;
    this.testFetchCodexRateLimitsViaAppServer = null;
  }

  getCachedSummary(nowMs, { forceRefresh = false, ignoreBackoff = false } = {}) {
    if (!this.usageSummaryCache?.summary) return null;
    const cacheInBackoff = this.usageSummaryCache.nextRetryAt && nowMs < this.usageSummaryCache.nextRetryAt;
    if ((cacheInBackoff && !ignoreBackoff)
      || (!forceRefresh && nowMs - this.usageSummaryCache.cachedAt <= this.cacheMs())) {
      return this.cloneUsageSummary(this.usageSummaryCache.summary);
    }
    return null;
  }

  currentSummary() {
    return this.usageSummaryCache?.summary
      ? this.cloneUsageSummary(this.usageSummaryCache.summary)
      : null;
  }

  storeSummary(summary, nowMs, { nextRetryAt = 0 } = {}) {
    this.usageSummaryCache = { cachedAt: nowMs, nextRetryAt, summary };
    return this.cloneUsageSummary(summary);
  }

  storeUnavailableSummary(summary, nowMs) {
    return this.storeSummary(summary, nowMs, {
      nextRetryAt: nowMs + this.backoffMs(),
    });
  }

  markInteractiveUsageUnavailable(err) {
    if (this.interactiveUsageUnavailableReason) return;
    const reason = firstErrorLine(err);
    this.interactiveUsageUnavailableReason = reason || "interactive usage probe failed";
    this.logger?.warn?.("provider", "Codex interactive usage probe unavailable; falling back to app-server", {
      error: this.interactiveUsageUnavailableReason,
    });
  }

  shouldSkipInteractiveUsage({ allowInteractiveOnWindows = false, platform = process.platform } = {}) {
    if (this.interactiveUsageUnavailableReason) return this.interactiveUsageUnavailableReason;
    if (platform === "win32" && !allowInteractiveOnWindows) {
      this.markInteractiveUsageUnavailable("disabled on Windows because node-pty ConPTY attach can block provider usage refresh");
      return this.interactiveUsageUnavailableReason;
    }
    return null;
  }

  setFetchers({ interactive = null, appServer = null } = {}) {
    this.testFetchCodexStatusViaInteractive = typeof interactive === "function" ? interactive : null;
    this.testFetchCodexRateLimitsViaAppServer = typeof appServer === "function" ? appServer : null;
  }

  getFetchers({ interactive, appServer } = {}) {
    return {
      interactive: this.testFetchCodexStatusViaInteractive || interactive,
      appServer: this.testFetchCodexRateLimitsViaAppServer || appServer,
    };
  }
}
