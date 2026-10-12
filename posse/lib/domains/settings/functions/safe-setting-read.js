// @ts-check

import { getSetting } from "../../queue/functions/index.js";

export function readSettingText(key, projectDir = null) {
  try {
    const value = getSetting(key, projectDir ? { projectDir } : {});
    return value == null ? "" : String(value).trim();
  } catch {
    return "";
  }
}

export function readSettingBool(key, fallback = false) {
  const value = readSettingText(key).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}
