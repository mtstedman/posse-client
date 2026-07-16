import { getAccountSetting } from "../../../domains/settings/functions/account-settings.js";

export function atlasMemoryEnabled() {
  const env = String(process.env.POSSE_MEMORY_MODE || "").trim().toLowerCase();
  if (env) return !["off", "disabled", "none", "0", "false"].includes(env);
  try {
    const value = String(getAccountSetting("atlas_memory_mode") || "on").trim().toLowerCase();
    return !["off", "disabled", "none", "0", "false"].includes(value);
  } catch {
    return true;
  }
}

export const ATLAS_MEMORY_TOOL_NAMES = new Set([
  "memory.store", "memory.surface", "memory.get", "memory.feedback",
]);

function canonicalToolName(entry) {
  const raw = String(entry?.name || entry?.local_name || entry || "").trim().toLowerCase();
  return raw
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^atlas[._-]/, "")
    .replace(/^memory[._-](store|surface|get|feedback)$/, "memory.$1");
}

export function withoutAtlasMemoryTools(surface) {
  if (!surface || typeof surface !== "object" || !Array.isArray(surface.tools)) return surface;
  return {
    ...surface,
    tools: surface.tools.filter((entry) => {
      return !ATLAS_MEMORY_TOOL_NAMES.has(canonicalToolName(entry));
    }),
  };
}
