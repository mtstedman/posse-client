// @ts-check

import { stripHashRefSurfaceSuffix } from "../../../shared/tools/functions/ref-surface.js";

export function parseResult(resultText) {
  if (typeof resultText !== "string" || !resultText.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(stripHashRefSurfaceSuffix(resultText));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
