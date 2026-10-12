import "../shared/setting-read.js";
export { readModelSetting } from "../shared/setting-read.js";
// lib/domains/providers/functions/codex/settings.js

import { getSetting } from "../../../queue/functions/index.js";


export function readPositiveMsSetting(key, fallback) {
  try {
    const parsed = Number.parseInt(String(getSetting(key) || ""), 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
  } catch {
    return fallback;
  }
}
