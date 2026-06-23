// lib/domains/providers/functions/codex/settings.js

import { getSetting } from "../../../queue/functions/index.js";

export function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}

export function readPositiveMsSetting(key, fallback) {
  try {
    const parsed = Number.parseInt(String(getSetting(key) || ""), 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : fallback;
  } catch {
    return fallback;
  }
}
