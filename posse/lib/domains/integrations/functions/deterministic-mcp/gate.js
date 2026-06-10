import { getObservationContext } from "../../../observability/functions/observations.js";
import { ToolGate } from "../../../../classes/tools/ToolGate.js";
import {
  GATED_NATIVE_TOOLS,
  GATED_ROLES,
  MEANINGFUL_ATLAS_ACTIONS,
} from "./tool-descriptors.js";

const REQUIRED_MEANINGFUL_ATLAS_CALLS = 3;
const FALLBACK_STRIKE_LIMIT = REQUIRED_MEANINGFUL_ATLAS_CALLS;
const DEFAULT_SCOPE = "__default__";

const _gates = new Map();

function _resolveScope(explicit) {
  if (explicit) return String(explicit);
  try {
    const ctx = getObservationContext();
    if (ctx?.job_id != null) return `job:${ctx.job_id}`;
  } catch {
    // Guard only.
  }
  return DEFAULT_SCOPE;
}

function _freshGate() {
  return new ToolGate({
    gatedRoles: GATED_ROLES,
    gatedTools: GATED_NATIVE_TOOLS,
    meaningfulAtlasActions: MEANINGFUL_ATLAS_ACTIONS,
    fallbackStrikeLimit: FALLBACK_STRIKE_LIMIT,
    requiredMeaningfulAtlasCalls: REQUIRED_MEANINGFUL_ATLAS_CALLS,
  });
}

function _getGate(scopeKey) {
  const key = _resolveScope(scopeKey);
  let gate = _gates.get(key);
  if (!gate) {
    gate = _freshGate();
    _gates.set(key, gate);
  }
  return gate;
}

export function createToolGate({ role = null, atlasAvailable = false, enabled = true, atlasLabel = "ATLAS" } = {}) {
  const gate = _freshGate();
  gate.configure({ role, atlasAvailable: !!enabled && !!atlasAvailable, atlasLabel });
  return gate;
}

export function configureGate({ role = null, atlasAvailable = false, scopeKey = null, enabled = true, atlasLabel = "ATLAS" } = {}) {
  const key = _resolveScope(scopeKey);
  const gate = _getGate(key);
  gate.configure({ role, atlasAvailable: !!enabled && !!atlasAvailable, atlasLabel });
  return key;
}

export function releaseGate({ scopeKey = null } = {}) {
  _gates.delete(_resolveScope(scopeKey));
}

export function isGateActive({ scopeKey = null } = {}) {
  return _getGate(scopeKey).isActive();
}

export function isGatedTool(toolName) {
  return GATED_NATIVE_TOOLS.has(toolName);
}

export function isUnlocked({ scopeKey = null } = {}) {
  return _getGate(scopeKey).isUnlocked();
}

export function checkNativeToolAllowed(toolName, args = {}, { cwd = null, scopeKey = null } = {}) {
  return _getGate(scopeKey).checkNativeToolAllowed(toolName, args, { cwd });
}

export function isNativeToolAllowed(toolName, args = {}, { cwd = null, scopeKey = null } = {}) {
  return checkNativeToolAllowed(toolName, args, { cwd, scopeKey }).allowed === true;
}

export function isFileDiscoveredForGate(filePath, { cwd = null, scopeKey = null } = {}) {
  return _getGate(scopeKey).isFileDiscovered(filePath, { cwd });
}

export function getUnlockReason({ scopeKey = null } = {}) {
  return _getGate(scopeKey).getUnlockReason();
}

export function getUnhelpfulStrikes({ scopeKey = null } = {}) {
  return _getGate(scopeKey).getUnhelpfulStrikes();
}

export function getMeaningfulAtlasCalls({ scopeKey = null } = {}) {
  return _getGate(scopeKey).getMeaningfulAtlasCalls();
}

export function getFallbackStrikeLimit() {
  return FALLBACK_STRIKE_LIMIT;
}

export function getRequiredMeaningfulAtlasCalls() {
  return REQUIRED_MEANINGFUL_ATLAS_CALLS;
}

export function noteAtlasCall({ action = "", ok = false, empty = false, args = {}, artifacts = null, cwd = null, scopeKey = null } = {}) {
  _getGate(scopeKey).noteAtlasCall({ action, ok, empty, args, artifacts, cwd });
}

export function unlockForAtlasUnavailable({ reason = "atlas_unavailable", scopeKey = null } = {}) {
  _getGate(scopeKey).unlockForAtlasUnavailable({ reason });
}

export function unlockForAtlasPrefetch({ reason = "prefetch_ok", scopeKey = null } = {}) {
  void reason;
  void scopeKey;
  return false;
}

export function isRelevantAtlasPrefetchStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "ok" || normalized === "ok_relevant" || normalized === "prefetch_ok_relevant";
}

export function isFallbackAtlasPrefetchStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized || normalized === "skipped") return false;
  if (isRelevantAtlasPrefetchStatus(normalized)) return false;
  if (normalized === "ok_unhelpful" || normalized === "prefetch_ok_unhelpful") return false;
  return true;
}

export function buildLockedToolError(toolName, { args = {}, cwd = null, scopeKey = null, atlasNameStyle = "dotted" } = {}) {
  return _getGate(scopeKey).buildLockedToolError(toolName, { args, cwd, atlasNameStyle });
}

export function __resetGateForTests() {
  _gates.clear();
}

export function __peekMeaningfulActions() {
  return new Set(MEANINGFUL_ATLAS_ACTIONS);
}

export function __peekGatedTools() {
  return new Set(GATED_NATIVE_TOOLS);
}

export function __peekGateKeys() {
  return [..._gates.keys()];
}
