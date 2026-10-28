import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getSetting } from "../../../queue/functions/index.js";
import { WEB_TOOL_ROLES } from "../../../../catalog/tool-surface/roles.js";
import { issuedWebAccessEnabled } from "../../../../shared/tools/functions/issued-tool-policy.js";

export function providerWebAccessEnabled({ role, disableAgentTools = false, remoteIssuedPolicy = null }) {
  return !disableAgentTools && WEB_TOOL_ROLES.has(role)
    && issuedWebAccessEnabled(remoteIssuedPolicy) && resolveWebToolsEnabled();
}

export function resolveWebToolsEnabled() {
  try {
    const stored = getSetting(SETTING_KEYS.WEB_TOOLS_ENABLED);
    if (stored == null) return true;
    const normalized = String(stored).trim().toLowerCase();
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
    return true;
  } catch {
    return true;
  }
}

export function resolveDisableSystemTools() {
  try {
    const stored = getSetting(SETTING_KEYS.DISABLE_SYSTEM_TOOLS);
    if (stored != null && String(stored).trim() !== "") {
      const normalized = String(stored).trim().toLowerCase();
      if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") return false;
      return true;
    }
  } catch {
    return true;
  }
  return true;
}
