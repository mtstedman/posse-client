// lib/domains/ui/functions/display/helpers/brand.js
//
// Shared visual primitives for the brand-tinted runtime UX:
//   - per-provider and per-role accent colors
//   - pressure tiers (green / yellow / orange / red) for budget gauges
//   - a horizontal rule with an embedded brand-tinted label
//   - a pressure-graded gauge that returns ANSI strings for bar / pct / optional glyph
//
// These primitives are used by the provider-usage footer, the approval-mode
// Tokens tab, and the right-panel pipeline/tools sections so the same visual
// language carries across the whole TUI.

import { C } from "../../../../../shared/format/functions/colors.js";

const PROVIDER_BRAND_COLORS = Object.freeze({
  claude: C.orange,
  openai: C.green,
  codex: C.cyan,
  grok: C.magenta,
});

const ROLE_BRAND_COLORS = Object.freeze({
  research: C.magenta,
  researcher: C.magenta,
  preflight: C.blue,
  plan: C.cyan,
  planner: C.cyan,
  delegate: C.blue,
  delegator: C.blue,
  dev: C.green,
  developer: C.green,
  fix: C.yellow,
  artificer: C.blue,
  assess: C.yellow,
  assessor: C.yellow,
  human_input: C.yellow,
  human: C.yellow,
  promote: C.magenta,
  atlas_warm: C.cyan,
  summary: C.cyan,
  system: C.magenta,
});

const ROLE_BRAND_ICONS = Object.freeze({
  research: "R",
  researcher: "R",
  preflight: "L",
  plan: "P",
  planner: "P",
  delegate: "G",
  delegator: "G",
  dev: "D",
  developer: "D",
  fix: "F",
  artificer: "C",
  assess: "A",
  assessor: "A",
  human_input: "H",
  human: "H",
  promote: "M",
  atlas_warm: "W",
  summary: "S",
  system: "S",
});

const ROLE_BRAND_LABELS = Object.freeze({
  dev: "developer",
  developer: "developer",
  research: "researcher",
  researcher: "researcher",
  plan: "planner",
  planner: "planner",
  assess: "assessor",
  assessor: "assessor",
  delegate: "delegator",
  delegator: "delegator",
  artificer: "artificer",
  preflight: "preflight",
  human_input: "human",
  human: "human",
  promote: "promote",
  atlas_warm: "atlas warm",
  summary: "summary",
  system: "system",
});

export function providerBrandColor(provider) {
  const key = String(provider || "").trim().toLowerCase();
  return PROVIDER_BRAND_COLORS[key] || C.cyan;
}

export function roleBrandColor(role, fallback = C.dim) {
  const key = String(role || "").trim().toLowerCase();
  return ROLE_BRAND_COLORS[key] || fallback;
}

export function roleBrandIcon(role, fallback = "?") {
  const key = String(role || "").trim().toLowerCase();
  return ROLE_BRAND_ICONS[key] || fallback;
}

export function roleBrandLabel(role, fallback = null) {
  const key = String(role || "").trim().toLowerCase();
  return ROLE_BRAND_LABELS[key] || fallback || key || "unknown";
}

/**
 * Tier thresholds:
 *   ≥ 95: red    (critical)
 *   ≥ 90: orange (warning)
 *   ≥ 60: yellow (caution)
 *   else: green (calm)
 * Pressure is shown by color only; compact footer rows do not emit alert glyphs.
 */
export function pressureTier(pct, colors = C) {
  const n = Number(pct) || 0;
  if (n >= 95) return { color: colors.red, glyph: "" };
  if (n >= 90) return { color: colors.orange, glyph: "" };
  if (n >= 60) return { color: colors.yellow, glyph: "" };
  return { color: colors.green, glyph: "" };
}

/**
 * `╶━━ LABEL ━━━━━━━━━━━━━━━━━━━━━━━╴` — a heavy box-drawing rule with the
 * supplied label embedded near the left. `color` is applied to the bars and
 * the label gets bolded on top of that color. The returned string starts with
 * a single leading space so it slots into the TUI's 1-char inner gutter.
 */
export function brandRule({ label, color, width }) {
  const safeWidth = Math.max(20, Math.min(Number(width) || 56, 120));
  const text = String(label || "").toUpperCase();
  const prefix = "╶━━ ";
  const suffix = " ";
  const head = prefix.length + text.length + suffix.length;
  const tailLen = Math.max(3, safeWidth - head - 2); // -2: leading space + tail cap
  const tail = `${"━".repeat(tailLen - 1)}╴`;
  return ` ${color}${prefix}${C.reset}${C.bold}${color}${text}${C.reset}${color}${suffix}${tail}${C.reset}`;
}

/**
 * Build a pressure-graded gauge for a value in [0..100].
 *   - Filled blocks stay green while pct < 60, then escalate to the tier color
 *     (yellow -> orange -> red).
 *   - Returns { bar, pctText, glyph, tierColor } as ANSI strings so callers can compose.
 */
/**
 * A readiness gauge: like brandGauge but a fixed fill color (NOT pressure-graded
 * — for readiness, full is good, so escalating green→red would be backwards).
 * Returns { bar, clamped, known }; `known=false` (pct null/non-finite) renders an
 * empty bar so callers can show "off"/"—".
 */
export function readinessGauge(pct, { width = 10, color = C.cyan, colors = C } = {}) {
  const n = Number(pct);
  const known = pct != null && pct !== "" && Number.isFinite(n);
  const clamped = known ? Math.max(0, Math.min(100, n)) : 0;
  const filled = known ? Math.max(0, Math.min(width, Math.round((clamped / 100) * width))) : 0;
  const empty = width - filled;
  // Fill segment with a bright leading-edge "head". A partially-filled bar caps
  // its frontier with a bright cell so an easing/advancing bar reads as motion;
  // a full bar is solid (calm "done"), an empty bar is just the dim track.
  let fillSeg;
  if (filled <= 0) {
    fillSeg = "";
  } else if (filled >= width) {
    fillSeg = `${color}${"█".repeat(width)}${colors.reset}`;
  } else {
    fillSeg = `${color}${"█".repeat(filled - 1)}${colors.reset}${colors.brightWhite}█${colors.reset}`;
  }
  const bar = `${colors.dim}▕${colors.reset}${fillSeg}${colors.dim}${"░".repeat(empty)}▏${colors.reset}`;
  return { bar, clamped, known };
}

export function brandGauge(pct, { width = 20, colors = C } = {}) {
  if (pct == null || pct === "") return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.max(0, Math.min(100, n));
  const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
  const empty = width - filled;
  const tier = pressureTier(clamped, colors);
  const fillColor = clamped < 60 ? colors.green : tier.color;
  const bar = `${colors.dim}▕${colors.reset}${fillColor}${"█".repeat(filled)}${colors.reset}${colors.dim}${"░".repeat(empty)}▏${colors.reset}`;
  const pctStr = String(Math.round(clamped)).padStart(3, " ");
  return {
    bar,
    pctText: `${tier.color}${colors.bold}${pctStr}%${colors.reset}`,
    glyph: tier.glyph ? `${tier.color}${tier.glyph}${colors.reset}` : "",
    tierColor: tier.color,
    clamped,
  };
}
