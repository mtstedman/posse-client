// @ts-check
//
// Singleton store for the local-ONNX encoder warm progress, shared between
// run-session.js (writes from the ThreadManager onProgress callback) and the
// TUI Display (reads to render a status chip).
//
// The transformers.js pipeline init doesn't expose per-file progress, so the
// "loading" phase has no real percent — we synthesise one against an expected
// duration so the chip has visible movement, and snap to 100% on the worker's
// "ready" event.

const EXPECTED_LOAD_MS = 6000;

/**
 * @typedef {Object} OnnxWarmState
 * @property {"idle" | "loading" | "ready" | "failed"} phase
 * @property {number | null} startedAt   ms epoch
 * @property {number | null} finishedAt  ms epoch
 * @property {string | null} error       last failure message
 */

/** @type {OnnxWarmState} */
let _state = Object.freeze({
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  error: null,
});

/** @returns {OnnxWarmState} */
export function getOnnxWarmState() {
  return _state;
}

/** @param {Partial<OnnxWarmState>} patch */
export function setOnnxWarmState(patch = {}) {
  _state = Object.freeze({ ..._state, ...patch });
}

export function resetOnnxWarmState() {
  setOnnxWarmState({ phase: "idle", startedAt: null, finishedAt: null, error: null });
}

/**
 * Synthetic 0..100 percent for the loading phase. Eases via a 1 - e^(-t/τ)
 * curve so it climbs quickly at first and asymptotes near 95% — visible
 * movement without ever lying about being done.
 *
 * @param {number} [nowMs]
 * @returns {number}
 */
export function syntheticOnnxLoadPercent(nowMs = Date.now()) {
  if (_state.phase === "ready") return 100;
  if (_state.phase === "failed") return 0;
  if (_state.phase !== "loading" || !_state.startedAt) return 0;
  const elapsed = Math.max(0, nowMs - _state.startedAt);
  const tau = EXPECTED_LOAD_MS / 2;
  const eased = 1 - Math.exp(-elapsed / tau);
  return Math.min(95, Math.round(eased * 95));
}

/**
 * One-line chip text suitable for inclusion in a status row. Returns null
 * when the warm hasn't started or doesn't apply, so callers can hide the row.
 *
 * @param {{ C: Record<string, string> }} opts
 * @returns {string | null}
 */
export function formatOnnxWarmChip({ C } = /** @type {any} */ ({})) {
  const c = C || {};
  const reset = c.reset || "\x1b[0m";
  const dim = c.dim || "";
  const green = c.green || "";
  const cyan = c.cyan || "";
  const red = c.red || "";
  if (_state.phase === "idle") return null;
  if (_state.phase === "loading") {
    const pct = syntheticOnnxLoadPercent();
    const elapsedSec = _state.startedAt ? ((Date.now() - _state.startedAt) / 1000).toFixed(1) : "0.0";
    return `${dim}·${reset} ${cyan}ONNX warming${reset} ${dim}${pct}% (${elapsedSec}s)${reset}`;
  }
  if (_state.phase === "ready") {
    const durationSec = _state.startedAt && _state.finishedAt
      ? ((_state.finishedAt - _state.startedAt) / 1000).toFixed(1)
      : null;
    const suffix = durationSec ? ` ${dim}(${durationSec}s)${reset}` : "";
    return `${dim}·${reset} ${green}ONNX ready${reset}${suffix}`;
  }
  if (_state.phase === "failed") {
    const msg = _state.error || "unknown";
    const short = msg.length > 60 ? `${msg.slice(0, 59)}…` : msg;
    return `${dim}·${reset} ${red}ONNX warm failed${reset} ${dim}(${short})${reset}`;
  }
  return null;
}
