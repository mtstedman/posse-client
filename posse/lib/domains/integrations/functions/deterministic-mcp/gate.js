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

// Result texts that mean ATLAS itself is gone (runtime-disabled, dead backend,
// failed proxy) rather than a single call failing. These must unlock the gate:
// the gate's premise is "ATLAS-first while ATLAS is available", and a dead
// ATLAS must never keep standard tools (edit/read/bash) locked.
const DEAD_ATLAS_RESULT_PATTERNS = [
  /ATLAS is disabled by configuration/i,
  /ATLAS is disabled for this repository/i,
  /ATLAS temporarily disabled for \d+s/i,
  /backend unavailable/i,
  /ATLAS proxy init failed/i,
];

export function isDeadAtlasResultText(text) {
  const raw = String(text ?? "");
  if (!raw) return false;
  return DEAD_ATLAS_RESULT_PATTERNS.some((pattern) => pattern.test(raw));
}

/* When an ATLAS tool result reports ATLAS itself is dead, unlock the gate for
 * the scope and return a notice to append to that same tool result, so the
 * agent learns in-band — at the moment of failure — that standard tools are
 * available. Returns null when the text is not a dead-ATLAS error or the gate
 * was never active (tools were never locked, no notice needed). The atlas_*
 * reason also dissolves per-file read locks (isUnavailableUnlockReason). */
export function unlockGateForDeadAtlasResult(resultText, { scopeKey = null, reason = "atlas_runtime_disabled" } = {}) {
  if (!isDeadAtlasResultText(resultText)) return null;
  const gate = _getGate(scopeKey);
  if (!gate.isActive()) return null;
  gate.unlockForAtlasUnavailable({ reason });
  const label = gate.atlasLabel || "ATLAS";
  return [
    `[${label}-first] ${label} is unavailable, so the ${label}-first gate has been unlocked for this job.`,
    `Standard tools (read_file, search_files, list_files, edit_file, write_file, bash, ...) are available now,`,
    `including reads of files that had no prior ${label} discovery. Use them directly; ${label} calls are not required first.`,
  ].join(" ");
}

/* Classify an embedded ATLAS tool result, notify the gate, and return the
 * result text — decorated with the in-band unlock notice when the result
 * reports ATLAS itself is dead. Single entry point for provider tool loops
 * (grok/openai executeTool); the embedded executor's conventions ("Error: ..."
 * on failure, "ATLAS returned no output." on empty success) live here once. */
export function noteAtlasToolResult(result, { action = "", args = {}, cwd = null, scopeKey = null } = {}) {
  const text = typeof result === "string" ? result : String(result ?? "");
  const errored = /^Error:/i.test(text);
  const empty = !errored && (text.trim().length === 0 || text.trim() === "ATLAS returned no output.");
  noteAtlasCall({ action, ok: !errored, empty, args, cwd, scopeKey });
  if (errored) {
    const unlockNotice = unlockGateForDeadAtlasResult(text, { scopeKey });
    if (unlockNotice) return `${text}\n\n${unlockNotice}`;
  }
  return text;
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
