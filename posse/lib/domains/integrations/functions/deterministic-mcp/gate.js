import { getObservationContext, recordObservation } from "../../../observability/functions/observations.js";
import { ToolGate } from "../../../../shared/tools/classes/ToolGate.js";
import {
  GATED_NATIVE_TOOLS,
  GATED_ROLES,
  MEANINGFUL_ATLAS_ACTIONS,
} from "./tool-descriptors.js";
import { resolveAtlasGateNudgeEnabled } from "./gate-settings.js";

const REQUIRED_MEANINGFUL_ATLAS_CALLS = 3;
const FALLBACK_STRIKE_LIMIT = REQUIRED_MEANINGFUL_ATLAS_CALLS;
const DEFAULT_SCOPE = "__default__";
const PRESSURE_TTL_MS = 60 * 60 * 1000;
const PRESSURE_STATE_LIMIT = 5000;
const PRESSURE_TOTAL_THRESHOLD = 4;
const PRESSURE_WINDOW_THRESHOLD = 2;

const _gates = new Map();
const _pressure = new Map();

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
  return maybeRecordAtlasShadowTokenPressure({ action, args, artifacts, scopeKey });
}

/* L3a (TOKEN-LEVERS-PLAN): pressure counting + in-band nudge WITHOUT the
 * lock-gate side effects. For callers outside the gateway/embedded tool loops
 * (the MCP owner's ATLAS executor path), where the per-process ToolGate
 * instance is unrelated but ladder pressure should still be counted and — when
 * atlas_gate_nudge is on — steered in-band. Returns the nudge text to append
 * to the triggering tool result, or null. */
export function noteAtlasPressureAndGetNudge({ action = "", args = {}, artifacts = null, scopeKey = null } = {}) {
  return maybeRecordAtlasShadowTokenPressure({ action, args, artifacts, scopeKey });
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

// Machine codes carried in the structured error block that
// formatAtlasV2EmbeddedError appends to failure texts. Code-first
// classification: the prose patterns above remain as fallback for paths that
// predate the structured block; new unavailability modes should add a code
// here rather than another regex.
const DEAD_ATLAS_ERROR_CODES = new Set([
  "atlas_disabled",
  "atlas_runtime_disabled",
  "atlas_conductor_unavailable",
  "atlas_gate_timeout",
  "backend_unavailable",
]);

/**
 * Extract the structured error code from an ATLAS failure text. Only error
 * texts are parsed — a successful file.read of JSON that contains a "code"
 * key must not classify as anything.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function atlasErrorCodeFromResultText(text) {
  const raw = String(text ?? "");
  if (!/^Error:/i.test(raw)) return null;
  const match = /"code"\s*:\s*"([a-z0-9_.:-]+)"/i.exec(raw);
  return match ? match[1].toLowerCase() : null;
}

export function isDeadAtlasResultText(text) {
  const raw = String(text ?? "");
  if (!raw) return false;
  const code = atlasErrorCodeFromResultText(raw);
  if (code && DEAD_ATLAS_ERROR_CODES.has(code)) return true;
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
  const readTool = gate.role === "researcher" ? "chain_read" : "read_file";
  return [
    `[${label}-first] ${label} is unavailable, so the ${label}-first gate has been unlocked for this job.`,
    `Native research fallback tools (${readTool}, search_files, list_files, inspect_file, ...) are available now,`,
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
  const nudge = noteAtlasCall({ action, ok: !errored, empty, args, cwd, scopeKey });
  if (errored) {
    const unlockNotice = unlockGateForDeadAtlasResult(text, { scopeKey });
    if (unlockNotice) return `${text}\n\n${unlockNotice}`;
  }
  if (nudge && !errored) return `${text}\n\n${nudge}`;
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
  _pressure.clear();
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

function maybeRecordAtlasShadowTokenPressure({ action = "", args = {}, artifacts = null, scopeKey = null } = {}) {
  const effectiveAction = normalizeAtlasActionForPressure(action, args);
  if (effectiveAction !== "code.lens" && effectiveAction !== "code.window") return;

  prunePressureState();
  const scope = _resolveScope(scopeKey);
  const target = normalizePressureTarget(args, artifacts);
  const key = `${scope}\0${target}`;
  const entry = _pressure.get(key) || {
    scope,
    target,
    total: 0,
    byAction: {},
    emitted: new Set(),
    updatedAt: 0,
  };
  entry.total += 1;
  entry.byAction[effectiveAction] = (entry.byAction[effectiveAction] || 0) + 1;
  entry.updatedAt = Date.now();
  _pressure.delete(key);
  _pressure.set(key, entry);

  const windowCount = Number(entry.byAction["code.window"] || 0);
  const shouldEmitTotal = entry.total >= PRESSURE_TOTAL_THRESHOLD && !entry.emitted.has("total");
  const shouldEmitWindow = windowCount >= PRESSURE_WINDOW_THRESHOLD && !entry.emitted.has("window");
  if (!shouldEmitTotal && !shouldEmitWindow) return null;

  if (shouldEmitTotal) entry.emitted.add("total");
  if (shouldEmitWindow) entry.emitted.add("window");
  // L3a: with atlas_gate_nudge on, the threshold crossing steers the agent
  // in-band (returned nudge text appended to the triggering tool result)
  // instead of observation-only shadow mode.
  const nudgeEnabled = resolveAtlasGateNudgeEnabled();
  const recommendation = "Summarize the remaining evidence gap, use one area survey/structure call, or switch to a single targeted native-read exception instead of continuing per-file ladder loops.";
  try {
    const ctx = getObservationContext() || {};
    recordObservation({
      work_item_id: ctx.work_item_id ?? null,
      job_id: ctx.job_id ?? null,
      attempt_id: ctx.attempt_id ?? null,
      observation_type: "atlas.shadow.token_pressure",
      summary: `ATLAS ${nudgeEnabled ? "active" : "shadow"} token pressure: ${entry.total} lens/window call(s) for ${target}`,
      detail: {
        kind: "atlas_shadow_token_pressure",
        mode: nudgeEnabled ? "active" : "shadow",
        scope,
        target,
        total_ladder_calls: entry.total,
        code_lens_calls: Number(entry.byAction["code.lens"] || 0),
        code_window_calls: windowCount,
        last_action: effectiveAction,
        thresholds: {
          total: PRESSURE_TOTAL_THRESHOLD,
          code_window: PRESSURE_WINDOW_THRESHOLD,
        },
        recommendation,
      },
    });
  } catch {
    // Token-pressure telemetry is advisory only.
  }
  if (!nudgeEnabled) return null;
  return [
    `[token-pressure] ${entry.total} lens/window call(s) against ${target} so far`,
    `(${Number(entry.byAction["code.lens"] || 0)} lens, ${windowCount} window).`,
    recommendation,
  ].join(" ");
}

function normalizeAtlasActionForPressure(action, args = {}) {
  const raw = String(action || "").trim();
  const nested = String(args?.action || "").trim();
  const value = nested || raw;
  return value
    .replace(/^atlas[._]/i, "")
    .replace(/^code_lens$/i, "code.lens")
    .replace(/^code_window$/i, "code.window")
    .replace(/^query[._]/i, "")
    .toLowerCase();
}

function normalizePressureTarget(args = {}, artifacts = null) {
  const file = firstNonEmpty(args?.file, args?.path, args?.paths);
  if (file) return normalizePathLike(file);
  const symbol = firstNonEmpty(args?.symbolId, args?.symbolRef, args?.identifier);
  if (symbol) return String(symbol).slice(0, 160);
  const artifactFile = Array.isArray(artifacts?.symbols)
    ? artifacts.symbols.map((sym) => sym?.filePath).find(Boolean)
    : null;
  if (artifactFile) return normalizePathLike(artifactFile);
  return "*";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const first = value.find((item) => String(item || "").trim());
      if (first) return first;
      continue;
    }
    const text = String(value || "").trim();
    if (text) return text;
  }
  return null;
}

function normalizePathLike(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .slice(0, 200);
}

function prunePressureState() {
  const now = Date.now();
  for (const [key, entry] of _pressure) {
    if (now - Number(entry.updatedAt || 0) <= PRESSURE_TTL_MS) continue;
    _pressure.delete(key);
  }
  while (_pressure.size > PRESSURE_STATE_LIMIT) {
    const oldest = _pressure.keys().next().value;
    if (oldest == null) break;
    _pressure.delete(String(oldest));
  }
}
