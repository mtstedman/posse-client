// @ts-check
//
// Authority-mode helpers for the ATLAS v2-only integration.
//
// The DB-backed `atlas_v2` setting now controls whether ATLAS is enabled at
// all. Historical burn-in values are kept as aliases so existing settings rows
// keep loading, but no external runtime route remains:
//
//   - "off" / "0" / "false" / "legacy": ATLAS disabled
//   - "" / unset:                         v2 enabled
//   - "shadow" / "preferred":             deprecated aliases for v2 enabled
//   - "on" / "true" / "1" / "v2":         v2 enabled
//   - "required":                         v2 enabled, fail-closed semantics

import {
  ATLAS_V2_FLAG_OFF_VALUES as ATLAS_V2_OFF_VALUES,
  ATLAS_V2_FLAG_ON_VALUES as ATLAS_V2_TRUE_VALUES,
  VALID_ATLAS_SCIP_MODES,
} from "../../../catalog/atlas.js";

/** @typedef {"off" | "on" | "required"} AtlasV2Mode */

/**
 * Normalize the DB-backed ATLAS v2 mode into the v2-only operative modes.
 *
 * An unset (or empty-string) value resolves to "on". Set `atlas_v2=off`
 * explicitly to disable ATLAS.
 *
 * @param {string | null | undefined} [value]
 * @returns {AtlasV2Mode}
 */
export function normalizeAtlasV2Mode(value = "on") {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "") return "on";
  if (ATLAS_V2_OFF_VALUES.has(raw)) return "off";
  if (raw === "shadow" || raw === "preferred") return "on";
  if (raw === "required") return "required";
  if (ATLAS_V2_TRUE_VALUES.has(raw)) return "on";
  return "off";
}

/**
 * True when ATLAS v2 should provide the agent-facing ATLAS route.
 *
 * @param {AtlasV2Mode | string | null | undefined} mode
 * @returns {boolean}
 */
export function isAuthoritativeAtlasV2Mode(mode) {
  return mode === "on" || mode === "required";
}

/**
 * True when v2 should be treated as enabled for downstream configuration.
 *
 * @param {{ config?: any }} [args]
 * @returns {boolean}
 */
export function shouldUseAtlasV2({ config = null } = {}) {
  const configMode = String(config?.atlasV2Mode || "").trim().toLowerCase();
  let mode;
  if (configMode) mode = normalizeAtlasV2Mode(configMode);
  else if (config?.atlasV2Enabled === true) mode = "on";
  else if (config && config.enabled === false) mode = "off";
  else mode = normalizeAtlasV2Mode();
  if (!isAuthoritativeAtlasV2Mode(mode)) return false;
  if (config?.runtimeDisabled === true) return false;
  return true;
}

/**
 * Legacy dual-backend execution has been removed.
 *
 * @param {{ config?: any }} [args]
 * @returns {boolean}
 */
export function shouldRunDualBackends({ config = null } = {}) {
  void config;
  return false;
}

/**
 * Compatibility view retained for callers that have not yet dropped the
 * historical shadow API. It no longer enables dual execution.
 *
 * @typedef {"off" | "shadow" | "preferred" | "required"} ShadowAuthorityMode
 *
 * @param {string | null | undefined} [value]
 * @returns {ShadowAuthorityMode}
 */
export function shadowAuthorityMode(value = "shadow") {
  const mode = normalizeAtlasV2Mode(value);
  if (mode === "required" || mode === "on") return "required";
  return "off";
}

/**
 * Shadow execution has been removed; deprecated shadow values normalize to
 * normal v2-on behavior.
 *
 * @param {string | null | undefined} [value]
 * @returns {boolean}
 */
export function isAtlasShadowEnabled(value = "on") {
  void value;
  return false;
}

/** @typedef {"off" | "on" | "on-demand" | "both"} AtlasScipMode */

/**
 * Normalize the DB-backed SCIP mode to one of the four operative modes.
 * Unknown values resolve to `off`, matching the admin default. The legacy
 * `consume` value is accepted as an alias for `on` so older rows keep
 * working after the admin label changed.
 *
 * @param {string | null | undefined} [value]
 * @returns {AtlasScipMode}
 */
export function normalizeAtlasScipMode(value = "off") {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "off";
  if (raw === "consume") return "on";
  if (VALID_ATLAS_SCIP_MODES.has(raw)) return /** @type {AtlasScipMode} */ (raw);
  return "off";
}

/**
 * True when the warm phase should consume any `.scip` files it finds.
 *
 * @param {AtlasScipMode | string | null | undefined} mode
 * @returns {boolean}
 */
export function shouldRunScipPhase(mode) {
  return mode === "on" || mode === "on-demand" || mode === "both";
}
