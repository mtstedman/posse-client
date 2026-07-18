import { isRecyclableLane, providerRoleForJobType } from "./keys.js";
import { SESSION_RECYCLE_MODE_VALUES } from "../../settings/functions/catalog.js";

const RECYCLE_MODE_VALUES = new Set(SESSION_RECYCLE_MODE_VALUES);

const MODE_ALIASES = Object.freeze({
  "0": "off",
  false: "off",
  no: "off",
  disabled: "off",
  "1": "full",
  true: "full",
  yes: "full",
  enabled: "full",
});

function normalizeProviderList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizeRecycleMode(value) {
  const raw = String(value ?? "off").trim().toLowerCase();
  const mode = MODE_ALIASES[raw] || raw;
  if (RECYCLE_MODE_VALUES.has(mode)) return mode;
  return "off";
}

export function requiredCoverageRolesForMode(modeValue = "off") {
  const mode = normalizeRecycleMode(modeValue);
  if (mode === "dev-fix") return ["dev", "assessor"];
  if (mode === "full") return ["dev", "planner", "assessor"];
  return [];
}

export function providerCoverageForReuse({
  providerName,
  providerMap = {},
  mode = "off",
  requiredRoles = null,
} = {}) {
  const provider = String(providerName || "").trim().toLowerCase();
  const roles = Array.isArray(requiredRoles) ? requiredRoles : requiredCoverageRolesForMode(mode);
  const missing = [];
  for (const role of roles) {
    const providers = normalizeProviderList(providerMap?.[role]);
    if (!provider || !providers.includes(provider)) missing.push(role);
  }
  return {
    ok: missing.length === 0,
    provider,
    requiredRoles: roles,
    missingRoles: missing,
  };
}

export function transitionAllowsRecycling(fromJobType, toJobType) {
  const fromLane = providerRoleForJobType(fromJobType);
  const toLane = providerRoleForJobType(toJobType);
  if (!isRecyclableLane(toLane) || fromLane !== toLane) return false;

  const fromType = String(fromJobType || "").trim().toLowerCase();
  const toType = String(toJobType || "").trim().toLowerCase();
  if (fromType === "dev" && toType === "fix") return true;
  if (fromType === "fix" && toType === "fix") return true;
  if (fromType === "plan" && toType === "plan") return true;
  // A dev -> dev transition is a sibling task. Even identical file scope can
  // carry different requirements and handoff evidence, so it always starts a
  // fresh provider session. Retries of one job resume through the attempt path.
  if (fromType === "dev" && toType === "dev") return false;
  return false;
}
