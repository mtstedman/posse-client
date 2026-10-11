// Normalization and contract rendering for dev/fix execution modes.

import {
  DEFAULT_DEV_MODE,
  DEV_MODE_ALIASES,
  DEV_MODE_DEFINITIONS,
  DEV_MODE_ORDER,
} from "../../../catalog/dev-mode.js";

export {
  DEFAULT_DEV_MODE,
  DEFAULT_FIX_DEV_MODE,
  DEV_MODE_DEFINITIONS,
  DEV_MODE_ORDER,
} from "../../../catalog/dev-mode.js";

export function normalizeDevMode(value, {
  fallback = DEFAULT_DEV_MODE,
} = {}) {
  const raw = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const normalized = raw && Object.hasOwn(DEV_MODE_DEFINITIONS, raw)
    ? raw
    : (DEV_MODE_ALIASES[raw] || "");
  return Object.hasOwn(DEV_MODE_DEFINITIONS, normalized) ? normalized : fallback;
}

export function isValidDevMode(value) {
  return Object.hasOwn(DEV_MODE_DEFINITIONS, String(value || ""));
}

export function renderDevModePlannerContract() {
  const lines = [
    "DEV MODE SELECTION CONTRACT:",
    "For every repo code task (job_type \"dev\", task_mode \"code\"), set dev_mode to exactly one allowed value:",
  ];
  for (const mode of DEV_MODE_ORDER) {
    const def = DEV_MODE_DEFINITIONS[mode];
    lines.push(`- ${mode}: ${def.plannerUse}`);
  }
  lines.push("If unsure, use feature_impl. Do not invent new dev_mode values.");
  return lines.join("\n");
}

export function renderSelectedDevModeContract(mode = DEFAULT_DEV_MODE) {
  const normalized = normalizeDevMode(mode);
  const def = DEV_MODE_DEFINITIONS[normalized];
  const lines = [
    `DEV MODE: ${normalized} (${def.label})`,
    "This is a stable execution constraint for this dev/fix call.",
    ...def.developerRules.map((rule) => `- ${rule}`),
  ];
  return lines.join("\n");
}
