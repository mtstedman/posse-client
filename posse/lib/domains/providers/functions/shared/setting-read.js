// @ts-check

import { getSetting } from "../../../queue/functions/index.js";

export function readModelSetting(key) {
  try {
    const value = getSetting(key);
    return value && String(value).trim() ? String(value).trim() : null;
  } catch {
    return null;
  }
}
