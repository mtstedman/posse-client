import { log } from "../../../../shared/telemetry/functions/logging/logger.js";

function firstErrorLine(err) {
  return String(err?.message || err || "unknown").split("\n")[0].trim();
}

// The sync usage read (capacity checks, footer renders) has no network
// summary to fall back on until a refresh lands, so it rebuilds the local
// agent_calls rollup. Memoise that rollup briefly: a plan compile can ask for
// capacity dozens of times within a second.
export const DEFAULT_LOCAL_SUMMARY_MEMO_MS = 30_000;

export class CodexUsageState {
  constructor({
    cacheMs = () => 0,
    backoffMs = () => 0,
    cloneUsageSummary = (summary) => summary,
    localSummaryMemoMs = DEFAULT_LOCAL_SUMMARY_MEMO_MS,
    logger = log,
  } = {}) {
    this.cacheMs = typeof cacheMs === "function" ? cacheMs : () => 0;
    this.backoffMs = typeof backoffMs === "function" ? backoffMs : () => 0;
    this.cloneUsageSummary = typeof cloneUsageSummary === "function"
      ? cloneUsageSummary
      : (summary) => summary;
    this.localSummaryMemoMs = Number.isFinite(localSummaryMemoMs) && localSummaryMemoMs >= 0
      ? localSummaryMemoMs
      : DEFAULT_LOCAL_SUMMARY_MEMO_MS;
    this.logger = logger;
    this.reset();
  }

  reset() {
    this.usageSummaryCache = null;
    this.localSummaryMemo = null;
    this.interactiveUsageUnavailableReason = null;
    this.testFetchCodexStatusViaInteractive = null;
    this.testFetchCodexRateLimitsViaAppServer = null;
  }

  // Keyed on the caller's clock: a memo built at `at` serves reads whose
  // nowMs falls within [at, at + memoMs]. Reads with an earlier clock (tests
  // pin nowMs) rebuild rather than serve a summary from their future.
  getLocalSummary(nowMs, build) {
    const memo = this.localSummaryMemo;
    if (memo && nowMs >= memo.at && nowMs - memo.at <= this.localSummaryMemoMs) {
      return this.cloneUsageSummary(memo.summary);
    }
    const summary = build(nowMs);
    this.localSummaryMemo = { at: nowMs, summary };
    return this.cloneUsageSummary(summary);
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
