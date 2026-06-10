// @ts-check
//
// Process-global live ATLAS warm readiness — the data behind the TUI's two
// readiness bars (ATLAS composite + ONNX). `runRealWarmer` feeds it the
// ParseEngine progress events now streamed back over the daemon progress
// channel; the Display reads it each render tick. Single in-process singleton:
// the conductor serializes warms, so there's effectively one active warm at a
// time for the project the TUI is watching.
//
// Stage → bar mapping: the embeddings stage drives ONNX; every other stage
// (scip / freshness / parse / view-merge) drives the ATLAS composite. The bar
// shows live % while a warm runs and rests at "ready" (or "off" for ONNX when
// embeddings never fired) when idle.

const STALE_MS = 4000; // a warm that hasn't ticked in this long reads as idle

/** @typedef {{ active: boolean, atlas: number|null, onnx: number|null, lang: string|null, stage: string|null, sawEmbeddings: boolean, at: number }} WarmReadiness */

/** @type {WarmReadiness} */
let _s = { active: false, atlas: null, onnx: null, lang: null, stage: null, sawEmbeddings: false, at: 0 };

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function pickLang(event) {
  const lang = /** @type {any} */ (event)?.language;
  return typeof lang === "string" && lang.trim() ? lang.trim() : null;
}

/** Mark a warm as starting (resets the live state). */
export function warmReadinessStarted(now = Date.now()) {
  _s = { active: true, atlas: 0, onnx: null, lang: null, stage: "starting", sawEmbeddings: false, at: now };
}

/** Fold one ParseEngine progress event into the readiness state. */
export function warmReadinessProgress(event, now = Date.now()) {
  if (!event || typeof event !== "object") return;
  const stage = String(/** @type {any} */ (event).stage || "");
  const pct = clampPct(/** @type {any} */ (event).percent);
  const lang = pickLang(event);
  _s.active = true;
  _s.stage = stage || _s.stage;
  _s.at = now;
  if (lang) _s.lang = lang;
  if (stage === "embeddings") {
    _s.sawEmbeddings = true;
    if (pct != null) _s.onnx = pct;
  } else if (pct != null) {
    _s.atlas = pct;
  }
}

/**
 * Mark the warm done. On success the bars rest at "ready" (100%, ONNX stays
 * "off" when embeddings never fired — even a no-op warm reads ready). On failure
 * we just deactivate and keep the partial % (honest "incomplete").
 * @param {boolean} [success]
 * @param {number} [now]
 */
export function warmReadinessDone(success = true, now = Date.now()) {
  _s.active = false;
  _s.lang = null;
  _s.at = now;
  if (success) {
    _s.atlas = 100;
    _s.onnx = _s.sawEmbeddings ? 100 : null;
    _s.stage = "ready";
  } else {
    _s.stage = "incomplete";
  }
}

/**
 * Read the current readiness for rendering. `active` is false once the warm
 * finished OR the last tick went stale (a crashed/abandoned warm shouldn't pin
 * the bar mid-fill forever).
 * @param {number} [now]
 * @returns {WarmReadiness}
 */
export function getWarmReadiness(now = Date.now()) {
  const active = _s.active && now - _s.at < STALE_MS;
  return { ..._s, active };
}
