import {
  PLANNER_DISPATCH_MODES,
  PLANNER_DISPATCH_RETURN_MARGIN_MS,
  PLANNER_DISPATCH_SETTINGS,
} from "../../../catalog/planner-dispatch.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getSetting } from "../../settings/functions/repository-settings.js";

// Normalize persisted values as well as admin writes: older clients and direct
// SQLite writes do not necessarily pass the current settings validator.
export function normalizePlannerDispatchPolicy(values = {}) {
  const normalized = {};
  for (const entry of PLANNER_DISPATCH_SETTINGS) {
    const raw = values[entry.key];
    if (entry.numeric) {
      const parsed = !["string", "number"].includes(typeof raw) || String(raw).trim() === "" ? NaN : Number(raw);
      normalized[entry.key] = Number.isSafeInteger(parsed)
        ? Math.max(entry.numeric.min, Math.min(entry.numeric.max, parsed))
        : Number(entry.default);
    } else {
      const parsed = String(raw ?? "").trim().toLowerCase();
      normalized[entry.key] = entry.options.includes(parsed) ? parsed : entry.default;
    }
  }
  const mode = normalized[SETTING_KEYS.PLANNER_DISPATCH_MODE];
  const coordinationMode = String(values[SETTING_KEYS.AGENT_COORDINATION_MODE] ?? "handoff").trim().toLowerCase();
  const enabled = mode === PLANNER_DISPATCH_MODES.PLANNER && coordinationMode === "subagents";
  const toolTimeoutSec = normalized[SETTING_KEYS.AGENT_DISPATCH_TOOL_TIMEOUT_SEC];
  return Object.freeze({
    mode,
    enabled,
    inactiveReason: mode !== PLANNER_DISPATCH_MODES.PLANNER ? "router" : enabled ? null : "coordination_mode",
    effortCeiling: normalized[SETTING_KEYS.PLANNER_RESEARCH_EFFORT_CEILING],
    maxChildren: normalized[SETTING_KEYS.PLANNER_RESEARCH_MAX_CHILDREN],
    childTimeoutMs: Math.min(
      normalized[SETTING_KEYS.PLANNER_RESEARCH_CHILD_TIMEOUT_MS],
      toolTimeoutSec * 1000 - PLANNER_DISPATCH_RETURN_MARGIN_MS,
    ),
    childMaxTurns: normalized[SETTING_KEYS.PLANNER_RESEARCH_CHILD_MAX_TURNS],
    resultChars: normalized[SETTING_KEYS.PLANNER_RESEARCH_RESULT_CHARS],
    triageMaxTurns: normalized[SETTING_KEYS.PLANNER_DISPATCH_TRIAGE_MAX_TURNS],
    toolTimeoutSec,
  });
}

export function readPlannerDispatchPolicy({ projectDir = null, readSetting = getSetting } = {}) {
  const values = {};
  for (const key of [SETTING_KEYS.AGENT_COORDINATION_MODE, ...PLANNER_DISPATCH_SETTINGS.map((entry) => entry.key)]) {
    try {
      values[key] = readSetting(key, { projectDir });
    } catch {
      // Defaults keep dispatch inactive if the settings store is unavailable.
      values[key] = null;
    }
  }
  return normalizePlannerDispatchPolicy(values);
}
