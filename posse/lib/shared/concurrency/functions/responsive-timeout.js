// @ts-check
//
// A deadline that counts only time this thread could actually run.
//
// setTimeout measures wall-clock time. When a long synchronous call or a
// process suspension outlasts the delay, the timer fires on resume, and it
// fires first: Node runs expired timers before it polls I/O, so a reply that
// arrived during the stall is still unread. A peer that answered in time then
// reads as a timeout (Atlas527/530: a 16.8s boot stall beat the 15s native
// pulse deadline while the remote had already answered in milliseconds).
//
// The deadline advances in short ticks and credits each wake-up with at most
// the delay it asked for, so stalled time never counts. Expiry also yields
// one I/O poll before firing, so a reply already sitting in a socket is read
// first.

const DEFAULT_TICK_MS = 250;

/**
 * @param {() => void} callback
 * @param {number} ms
 * @param {{ tickMs?: number }} [options]
 * @returns {{ clear: () => void }}
 */
export function setResponsiveTimeout(callback, ms, { tickMs = DEFAULT_TICK_MS } = {}) {
  const tick = Math.max(1, Number(tickMs) || DEFAULT_TICK_MS);
  let remaining = Math.max(0, Number(ms) || 0);
  let last = performance.now();
  let planned = Math.min(tick, remaining);
  let settled = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {NodeJS.Immediate | null} */
  let immediate = null;
  const step = () => {
    const now = performance.now();
    remaining -= Math.min(now - last, planned);
    last = now;
    if (remaining > 0) {
      planned = Math.min(tick, remaining);
      timer = setTimeout(step, planned);
      return;
    }
    immediate = setImmediate(() => {
      if (settled) return;
      settled = true;
      callback();
    });
  };
  timer = setTimeout(step, planned);
  return {
    clear() {
      settled = true;
      if (timer) clearTimeout(timer);
      if (immediate) clearImmediate(immediate);
    },
  };
}
