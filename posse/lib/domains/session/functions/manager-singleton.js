import { SessionManager } from "../classes/SessionManager.js";
import { getProviderMap } from "../../providers/functions/provider.js";
import { getSetting, getWorkItem, getWorkItemRecycleOverride } from "../../queue/functions/index.js";
import {
  normalizeRecycleMode,
  requiredCoverageRolesForMode,
} from "./eligibility.js";

// Narrow process-local cache for the shared SessionManager. The durable session
// state stays in SQLite; this singleton only avoids rebuilding the facade.
let SESSION_MANAGER = null;
let SESSION_MANAGER_SIGNATURE = null;

function readSetting(key) {
  try {
    const value = getSetting(key);
    return value == null ? "" : String(value).trim();
  } catch {
    return "";
  }
}

export function resolveGlobalSessionRecycleMode() {
  return normalizeRecycleMode(readSetting("session_recycle_mode") || "off");
}

export function resolveSessionRecycleModeForWorkItem(workItemOrId, { fallbackMode = null } = {}) {
  const workItem = typeof workItemOrId === "object" && workItemOrId !== null
    ? workItemOrId
    : getWorkItem(workItemOrId);
  const override = getWorkItemRecycleOverride(workItem);
  if (override) return override;
  return normalizeRecycleMode(fallbackMode || resolveGlobalSessionRecycleMode());
}

function buildSignature({ recycleMode, providerMap, requiredRoles }) {
  return JSON.stringify({
    recycleMode,
    providerMap,
    requiredRoles,
  });
}

export function getSessionManager({
  recycleMode = resolveGlobalSessionRecycleMode(),
  providerMap = getProviderMap(),
  requiredRoles = requiredCoverageRolesForMode(recycleMode),
} = {}) {
  const normalizedMode = normalizeRecycleMode(recycleMode);
  const signature = buildSignature({
    recycleMode: normalizedMode,
    providerMap,
    requiredRoles,
  });
  if (!SESSION_MANAGER || SESSION_MANAGER_SIGNATURE !== signature) {
    SESSION_MANAGER = new SessionManager({
      recycleMode: normalizedMode,
      providerMap,
      requiredRoles,
    });
    SESSION_MANAGER_SIGNATURE = signature;
  }
  return SESSION_MANAGER;
}

export function resetSessionManagerForTests() {
  SESSION_MANAGER = null;
  SESSION_MANAGER_SIGNATURE = null;
}
