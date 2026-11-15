// @ts-check
// The scheduler fetches the shared trunk before it selects jobs. That fetch
// needs the project's root worktree lock, which a long ATLAS intake (for
// example after a big merge) can hold for minutes, and the poll only gives up
// at its 90s deadline. Waiting for it every lap therefore froze all dispatch.
// Bound the wait: a poll that overruns the budget keeps running in the
// background (the poller already fails open), and later laps neither wait on
// it nor start a second one until it settles.

export const TRUNK_POLL_LAP_BUDGET_MS = 8_000;

/**
 * @template T
 * @param {{ poll: (options: any) => Promise<T> }} poller
 * @param {any} pollOptions
 * @param {{ state: { pending: Promise<unknown> | null }, budgetMs?: number, onLate?: ((result: T) => void) | null }} opts
 * @returns {Promise<T | null>} the poll result, or null when it is still running
 */
export async function pollTrunkWithinBudget(poller, pollOptions, { state, budgetMs = TRUNK_POLL_LAP_BUDGET_MS, onLate = null }) {
  // An earlier lap already gave up waiting on a poll that has not settled.
  if (state.pending) return null;
  const run = Promise.resolve(poller.poll(pollOptions));
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const overran = new Promise((resolve) => {
    timer = setTimeout(() => resolve(/** @type {const} */ ("overran")), budgetMs);
    timer.unref?.();
  });
  try {
    const first = await Promise.race([run, overran]);
    if (first !== "overran") return /** @type {T} */ (first);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const tracked = run.then(
    (result) => { try { onLate?.(result); } catch { /* observational */ } },
    () => { /* the poller logs its own failures and fails open */ },
  ).finally(() => {
    if (state.pending === tracked) state.pending = null;
  });
  state.pending = tracked;
  return null;
}
