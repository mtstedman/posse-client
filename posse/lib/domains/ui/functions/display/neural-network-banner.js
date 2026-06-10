// @ts-check
//
// Reusable "NEURAL NETWORK" ASCII banner: 5-row block-text with the lettering
// rendered as negative space against a coloured background. The fill colour is
// a two-phase gradient:
//
//   phase 1: grey -> blue as the combined SCIP + ATLAS percent climbs to 100%
//   phase 2: blue -> green as the ONNX vector DB / encoder percent climbs to
//            100% (only animates once phase 1 saturates)
//
// Returns an array of pre-coloured strings ready to drop into any framed
// container. Currently consumed by the boot panel footer; suitable for re-use
// in the TUI status bar or a dedicated tile later — the contract is purely the
// three percent inputs plus an optional palette.

// 4-row bitmap font — "a titch smaller" than the original 5-row design while
// still readable. The bits are 1 = letter stroke, 0 = background.
const FONT = Object.freeze({
  N: ["█  █", "██ █", "█ ██", "█  █"],
  E: ["████", "███ ", "█   ", "████"],
  U: ["█  █", "█  █", "█  █", " ██ "],
  R: ["███ ", "███ ", "█ █ ", "█  █"],
  A: [" ██ ", "████", "█  █", "█  █"],
  L: ["█   ", "█   ", "█   ", "████"],
  T: ["████", " █  ", " █  ", " █  "],
  W: ["█   █", "█   █", "█ █ █", " █ █ "],
  O: [" ██ ", "█  █", "█  █", " ██ "],
  K: ["█  █", "█ █ ", "██  ", "█ █ "],
  " ": ["  ", "  ", "  ", "  "],
});

const BANNER_ROWS = 4;
// Inter-glyph gap of 1 column. Rendered as background dots (same as the
// blank pixels inside letters), so the gap visually flows with the field
// rather than reading as a hard separator.
const GLYPH_GAP = " ";
// Background padding wraps the letter rows so the outer N/K aren't flush
// against whatever frames the banner. Top/bottom rows are pure background;
// left/right cols extend the gradient field beyond the letters.
const PAD_ROWS = 1;
const PAD_COLS = 3;

// `▒` paints ~50% of the cell — denser than `░` so the gradient colour
// reads strongly against a dark terminal background without overpowering
// the letter strokes.
const GREY = [150, 150, 160];
const BLUE = [80, 150, 240];
const GREEN = [85, 215, 130];
// Letters use `█` (full block) in near-black with a hint of blue so they
// sit a touch warmer than pure black against the gradient field.
const LETTER_FG = "\x1b[38;2;18;20;30m";
const BG_CHAR = "▒";
const LETTER_CHAR = "█";

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function lerpRgb(a, b, t) {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function fgRgb([r, g, b]) {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Compute the active fill colour for the banner given progress in the three
 * tracked subsystems. Exposed so other surfaces (TUI tiles, status lines) can
 * render a matching dot or bar in the same colour without re-deriving phase
 * logic.
 *
 * @param {{ scipPercent?: number, atlasPercent?: number, onnxPercent?: number }} progress
 * @returns {{ rgb: [number, number, number], phase: 1 | 2, phaseProgress: number }}
 */
export function neuralNetworkBannerColor({
  scipPercent = 0,
  atlasPercent = 0,
  onnxPercent = 0,
} = {}) {
  const scip = Math.max(0, Math.min(100, Number(scipPercent) || 0));
  const atlas = Math.max(0, Math.min(100, Number(atlasPercent) || 0));
  const onnx = Math.max(0, Math.min(100, Number(onnxPercent) || 0));
  const phase1Progress = (scip + atlas) / 200;
  if (phase1Progress < 1) {
    return {
      rgb: /** @type {[number, number, number]} */ (lerpRgb(GREY, BLUE, phase1Progress)),
      phase: 1,
      phaseProgress: phase1Progress,
    };
  }
  const phase2Progress = onnx / 100;
  return {
    rgb: /** @type {[number, number, number]} */ (lerpRgb(BLUE, GREEN, phase2Progress)),
    phase: 2,
    phaseProgress: phase2Progress,
  };
}

/**
 * Render the banner as an array of strings. Each row carries ANSI colour
 * escapes; the negative-space pixels are plain ASCII spaces so the host
 * surface's background bleeds through.
 *
 * @param {{
 *   scipPercent?: number,
 *   atlasPercent?: number,
 *   onnxPercent?: number,
 *   text?: string,
 * }} opts
 * @returns {string[]}
 */
export function renderNeuralNetworkBanner({
  scipPercent = 0,
  atlasPercent = 0,
  onnxPercent = 0,
  text = "NEURAL NETWORK",
} = {}) {
  const { rgb } = neuralNetworkBannerColor({ scipPercent, atlasPercent, onnxPercent });
  const bgFg = fgRgb(rgb);
  const reset = "\x1b[0m";

  const glyphs = String(text)
    .toUpperCase()
    .split("")
    .map((ch) => FONT[ch] || FONT[" "]);

  // Compute the letter-row width once so we can build matching top/bottom
  // padding rows that span the full banner (letters + side padding).
  const letterRowWidth = glyphs.length === 0 ? 0 : (() => {
    const glyphWidths = glyphs.map((glyph) => Math.max(...glyph.map((row) => row.length)));
    return glyphWidths.reduce((a, b) => a + b, 0) + (glyphs.length - 1) * GLYPH_GAP.length;
  })();
  const fullRowWidth = letterRowWidth + PAD_COLS * 2;
  const padCols = PAD_COLS > 0 ? `${bgFg}${BG_CHAR.repeat(PAD_COLS)}${reset}` : "";
  const fullPadRow = fullRowWidth > 0 ? `${bgFg}${BG_CHAR.repeat(fullRowWidth)}${reset}` : "";

  const rows = [];
  // Top padding rows give the upper edge of the letters breathing room
  // against the panel frame.
  for (let p = 0; p < PAD_ROWS; p++) rows.push(fullPadRow);
  for (let r = 0; r < BANNER_ROWS; r++) {
    const parts = glyphs.map((glyph) => glyph[r] || "");
    const raw = parts.join(GLYPH_GAP);
    let out = padCols;
    let mode = /** @type {"letter" | "bg" | null} */ (null);
    for (const ch of raw) {
      if (ch === "█") {
        if (mode !== "letter") { out += LETTER_FG; mode = "letter"; }
        out += LETTER_CHAR;
      } else {
        // Every non-letter pixel (interior negative space + inter-glyph gap)
        // becomes a coloured medium-shade so the background reads as one
        // continuous gradient field with the letters punched out of it.
        if (mode !== "bg") { out += bgFg; mode = "bg"; }
        out += BG_CHAR;
      }
    }
    if (mode != null) out += reset;
    out += padCols;
    rows.push(out);
  }
  // Bottom padding rows mirror the top, framing the letters.
  for (let p = 0; p < PAD_ROWS; p++) rows.push(fullPadRow);
  return rows;
}

/**
 * Plain visible width of the banner (no ANSI). Useful for callers that need to
 * size a container or skip the banner when the surface is too narrow.
 *
 * @param {string} [text]
 * @returns {number}
 */
export function neuralNetworkBannerWidth(text = "NEURAL NETWORK") {
  const glyphs = String(text)
    .toUpperCase()
    .split("")
    .map((ch) => FONT[ch] || FONT[" "]);
  if (glyphs.length === 0) return 0;
  const glyphWidths = glyphs.map((glyph) => Math.max(...glyph.map((row) => row.length)));
  const widthsSum = glyphWidths.reduce((a, b) => a + b, 0);
  return widthsSum + (glyphs.length - 1) * GLYPH_GAP.length + PAD_COLS * 2;
}

export const NEURAL_NETWORK_BANNER_ROWS = BANNER_ROWS;
