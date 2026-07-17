import { getAccountSetting } from "../../../settings/functions/account-settings.js";

export const ATLAS_TOOL_GATE_SETTING = "atlas_tool_gate_enabled";
export const ATLAS_TOOL_GATE_DEFAULT = true;
export const ATLAS_CODE_LENS_CALLABLE_SETTING = "atlas_code_lens_callable";
export const ATLAS_CODE_LENS_CALLABLE_DEFAULT = true;

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

export const ATLAS_GATE_NUDGE_SETTING = "atlas_gate_nudge";
export const ATLAS_GATE_NUDGE_DEFAULT = false;

// L3a (TOKEN-LEVERS-PLAN): flip the token-pressure ladder detector from
// shadow (observation-only) to active steering — the recommendation is
// appended in-band to the triggering ATLAS tool result. Default OFF.
export function resolveAtlasGateNudgeEnabled() {
  try {
    return parseBoolean(getAccountSetting(ATLAS_GATE_NUDGE_SETTING), ATLAS_GATE_NUDGE_DEFAULT);
  } catch {
    return ATLAS_GATE_NUDGE_DEFAULT;
  }
}

export const ATLAS_GATEWAY_DEDUP_ADVERTISE_SETTING = "atlas_gateway_dedup_advertise";
export const ATLAS_GATEWAY_DEDUP_ADVERTISE_DEFAULT = false;

// L5a (TOKEN-LEVERS-PLAN): on the owner-hot gateway path the four ATLAS gateway
// wrappers (query/code/repo/agent) are advertised alongside the individual
// per-action tools they route to — the same surface twice. When enabled, drop
// the gateway wrappers from the advertised tools/list; all dispatch code stays,
// so remote-issued gateway calls still route. Default OFF (gateways advertised).
export function resolveAtlasGatewayDedupAdvertise() {
  try {
    return parseBoolean(getAccountSetting(ATLAS_GATEWAY_DEDUP_ADVERTISE_SETTING), ATLAS_GATEWAY_DEDUP_ADVERTISE_DEFAULT);
  } catch {
    return ATLAS_GATEWAY_DEDUP_ADVERTISE_DEFAULT;
  }
}

export const ATLAS_PROSE_DEDUP_SETTING = "atlas_prose_dedup";
export const ATLAS_PROSE_DEDUP_DEFAULT = false;

// L5b (TOKEN-LEVERS-PLAN): the role-contract closing fallback/anti-fabrication
// policy restates the retrieval policy already delivered by the handoff
// atlas-context prose. When enabled, the runtime role contract emits a compact
// single-statement variant (the handoff prose keeps the full policy — both text
// variants stay checked in). Default OFF (full policy in both places).
export function resolveAtlasProseDedup() {
  try {
    return parseBoolean(getAccountSetting(ATLAS_PROSE_DEDUP_SETTING), ATLAS_PROSE_DEDUP_DEFAULT);
  } catch {
    return ATLAS_PROSE_DEDUP_DEFAULT;
  }
}

export const ATLAS_TOOLS_DISABLED_SETTING = "atlas_tools_disabled";

// Generic ablation gate: comma/space-separated atlas action names removed
// from newly minted agent contracts (implementation stays available
// internally). Empty (default) disables nothing. code.lens keeps its legacy
// dedicated toggle; both compose.
export function resolveAtlasDisabledTools() {
  try {
    const raw = String(getAccountSetting(ATLAS_TOOLS_DISABLED_SETTING) ?? "").trim();
    if (!raw) return new Set();
    return new Set(raw.split(/[\s,;]+/).map((part) => part.trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function resolveAtlasCodeLensCallable() {
  try {
    return parseBoolean(
      getAccountSetting(ATLAS_CODE_LENS_CALLABLE_SETTING),
      ATLAS_CODE_LENS_CALLABLE_DEFAULT,
    );
  } catch {
    return ATLAS_CODE_LENS_CALLABLE_DEFAULT;
  }
}
