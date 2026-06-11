// @ts-check
//
// Process-global live ATLAS warm readiness — the data behind the TUI's two
// readiness bars (ATLAS composite + ONNX). `runRealWarmer` feeds it the
// ParseEngine progress events now streamed back over the daemon progress
// channel; the Display reads it each render tick. Single in-process singleton:
// the conductor serializes warms, so there's effectively one active warm at a
// time for the project the TUI is watching.
//
// Stage → bar mapping: the embeddings/encoding stages drive ONNX; every other
// stage (scip / freshness / parse / view-merge) drives the ATLAS composite.
// The bar shows live % while a warm runs and rests at "ready" / "incomplete".
//
// Honesty contract: resting labels reflect what we actually know.
//   * `atlasEnabled` / `onnxEnabled` come from real config (seeded at boot) —
//     `false` renders "off", `null` means "not yet known this session".
//   * A null percent means "never observed", NOT "off" — boot seeds the
//     resting percents from the boot warm's real result so a session that
//     booted with a current index rests at "ready" immediately.
//   * `warmReadinessDone` never downgrades ONNX: a successful warm whose
//     embeddings stage had nothing to do keeps the previous resting state.

const STALE_MS = 4000; // a warm that hasn't ticked in this long reads as idle

/** @typedef {{ active: boolean, atlas: number|null, onnx: number|null, lang: string|null, stage: string|null, sawEmbeddings: boolean, atlasEnabled: boolean|null, onnxEnabled: boolean|null, at: number }} WarmReadiness */

/** @type {WarmReadiness} */
let _s = {
  active: false,
  atlas: null,
  onnx: null,
  lang: null,
  stage: null,
  sawEmbeddings: false,
  atlasEnabled: null,
  onnxEnabled: null,
  at: 0,
};

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function pickLang(event) {
  const lang = /** @type {any} */ (event)?.language;
  return typeof lang === "string" && lang.trim() ? lang.trim() : null;
}

/** The encode pipeline reports under two stage names: "embeddings" for the
 * resource/check transitions, "encoding" for the per-symbol progress loop. */
function isOnnxStage(stage) {
  return stage === "embeddings" || stage === "encoding";
}

/** Mark a warm as starting. Resets the live ATLAS sweep but keeps the ONNX
 * resting state (a warm that never reaches embeddings shouldn't blank the
 * bar) and the seeded enablement flags. */
export function warmReadinessStarted(now = Date.now()) {
  _s = {
    ..._s,
    active: true,
    atlas: 0,
    lang: null,
    stage: "starting",
    sawEmbeddings: false,
    at: now,
  };
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
  if (isOnnxStage(stage)) {
    _s.sawEmbeddings = true;
    if (pct != null) _s.onnx = pct;
  } else if (pct != null) {
    _s.atlas = pct;
  }
}

/**
 * Mark the warm done. On success the ATLAS bar rests at "ready"; ONNX rests at
 * 100 only when the embeddings stage actually ran this warm — otherwise it
 * KEEPS its previous resting state (sticky), because "this warm didn't touch
 * embeddings" says nothing about whether the index is ready. On failure we
 * just deactivate and keep the partial % (honest "incomplete").
 * @param {boolean} [success]
 * @param {number} [now]
 */
export function warmReadinessDone(success = true, now = Date.now()) {
  _s.active = false;
  _s.lang = null;
  _s.at = now;
  if (success) {
    _s.atlas = 100;
    if (_s.sawEmbeddings) _s.onnx = 100;
    _s.stage = "ready";
  } else {
    _s.stage = "incomplete";
  }
}

/**
 * Seed the resting readiness from externally-derived real state — the boot
 * warm's result plus the resolved embeddings config. Fields left undefined
 * are not touched, so callers state only what they actually know.
 *
 * @param {{ atlas?: number|null, onnx?: number|null, atlasEnabled?: boolean|null, onnxEnabled?: boolean|null }} [seed]
 * @param {number} [now]
 */
export function warmReadinessSeed(seed = {}, now = Date.now()) {
  if (seed.atlas !== undefined) _s.atlas = seed.atlas == null ? null : clampPct(seed.atlas);
  if (seed.onnx !== undefined) _s.onnx = seed.onnx == null ? null : clampPct(seed.onnx);
  if (seed.atlasEnabled !== undefined) _s.atlasEnabled = seed.atlasEnabled == null ? null : !!seed.atlasEnabled;
  if (seed.onnxEnabled !== undefined) _s.onnxEnabled = seed.onnxEnabled == null ? null : !!seed.onnxEnabled;
  // Seeding describes a resting state (boot finished or skipped), so any
  // live sweep is over; runtime warm jobs re-activate via warmReadinessStarted.
  _s.active = false;
  _s.lang = null;
  _s.stage = "seeded";
  _s.at = now;
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

/** Test-only: return the singleton to its pristine pre-boot state. */
export function __resetWarmReadinessForTests() {
  _s = {
    active: false,
    atlas: null,
    onnx: null,
    lang: null,
    stage: null,
    sawEmbeddings: false,
    atlasEnabled: null,
    onnxEnabled: null,
    at: 0,
  };
}
