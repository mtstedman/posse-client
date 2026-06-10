import { getAccountSetting } from "../../../settings/functions/account-settings.js";

export const ATLAS_TOOL_GATE_SETTING = "atlas_tool_gate_enabled";
export const ATLAS_TOOL_GATE_DEFAULT = true;

function parseBoolean(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return fallback;
}

export function resolveAtlasToolGateEnabled() {
  try {
    return parseBoolean(getAccountSetting(ATLAS_TOOL_GATE_SETTING), ATLAS_TOOL_GATE_DEFAULT);
  } catch {
    return ATLAS_TOOL_GATE_DEFAULT;
  }
}
