import { CodexTerminalUsageFlush } from "../../classes/codex/CodexTerminalUsageFlush.js";

// Export the native dispatch usage flush contract.
export { CodexTerminalUsageFlush };

// The native Codex adapter reads the rollout on a 250 ms tick, so the native
// window spans four reads before the terminal usage grace window closes.
export const NATIVE_TERMINAL_USAGE_FLUSH_MS = 1000;

/**
 * Runs one native Codex dispatch so that a terminal-handoff stop first waits,
 * within a bound, for the usage segment of the request that made the handoff
 * call. Any other abort, or one already raised before the dispatch starts,
 * cancels at once. `run` receives the dispatch signal and a usage callback.
 */
export async function runWithTerminalUsageFlush(abortSignal, run, {
  timeoutMs = NATIVE_TERMINAL_USAGE_FLUSH_MS,
} = {}) {
  const dispatchAbort = new AbortController();
  const flush = new CodexTerminalUsageFlush((reason) => dispatchAbort.abort(reason), { timeoutMs });
  const onAbort = () => flush.request(abortSignal.reason);
  if (abortSignal?.aborted) dispatchAbort.abort(abortSignal.reason);
  else abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await run({ signal: dispatchAbort.signal, onUsage: () => flush.noteUsage() });
    if (result?.stats) Object.assign(result.stats, flush.snapshot());
    return result;
  } catch (error) {
    if (error && typeof error === "object") {
      const flushStats = flush.snapshot();
      const stats = Object.assign(error.stats || {}, flushStats);
      // Finalized usage that never received the stopped request's segment is
      // a lower bound, not a complete measurement.
      if (flushStats.terminalUsageFlushAttempted && !flushStats.terminalUsageFlushCompleted
        && stats.usageFinalized === true) {
        stats.usagePartialAfterStop = true;
      }
      error.stats = stats;
    }
    throw error;
  } finally {
    flush.cancel();
    abortSignal?.removeEventListener("abort", onAbort);
  }
}
