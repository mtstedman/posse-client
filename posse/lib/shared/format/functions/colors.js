// lib/format/colors.js
//
// Terminal colors shared by providers, workers, and role helpers.

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  brightWhite: "\x1b[97m",
  orange: "\x1b[38;5;208m",
};

function forcedColorState(env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(env, "FORCE_COLOR")) return null;
  const value = String(env.FORCE_COLOR ?? "").trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return true;
}

export function colorsEnabled({ env = process.env, stream = process.stdout } = {}) {
  const forced = forcedColorState(env);
  if (forced != null) return forced;
  if (Object.prototype.hasOwnProperty.call(env, "NO_COLOR")) return false;
  return !!stream?.isTTY;
}

export function buildColors(options = {}) {
  const enabled = colorsEnabled(options);
  return Object.fromEntries(Object.entries(ANSI).map(([key, value]) => [key, enabled ? value : ""]));
}

export const C = buildColors();
