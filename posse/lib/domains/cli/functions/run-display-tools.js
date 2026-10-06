import { TOOL_CATALOG } from "../../integrations/functions/deterministic-mcp/tool-descriptors.js";

/**
 * Small, structured projection of the canonical registered tool catalog for
 * the live Tools pane. This describes what Posse can issue; individual agents
 * still receive the role-, scope-, and capability-filtered subset.
 */
export function registeredToolCatalogSnapshot() {
  return Object.values(TOOL_CATALOG)
    .filter((entry) => entry?.surfaced === true && entry?.deprecated !== true)
    .map((entry) => ({
      name: String(entry.name || ""),
      access: String(entry.access || "unknown"),
      summary: String(entry.summary || ""),
      roles: [...(entry.roleAllowlist || [])].map(String).sort(),
    }))
    .filter((entry) => entry.name)
    .sort((a, b) => {
      const aAtlas = a.access === "atlas" ? 1 : 0;
      const bAtlas = b.access === "atlas" ? 1 : 0;
      return aAtlas - bAtlas || a.name.localeCompare(b.name);
    });
}
