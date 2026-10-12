// @ts-check

import { normalizeAtlasScipMode, shouldRunScipPhase } from "./atlas-v2-mode.js";

export function shouldConsiderScipRestage(config = {}) {
  const policy = String(config?.scipRestagePolicy || "missing").trim().toLowerCase();
  return shouldRunScipPhase(normalizeAtlasScipMode(config?.scipMode)) && (policy === "smart" || policy === "always");
}
