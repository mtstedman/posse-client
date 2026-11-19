// @ts-check
//
// One reading of the action a wrapper call (atlas.query, atlas.code,
// atlas.repo, atlas.agent) routes to. The MCP owner's session policy, the
// Atlas tool executor and v2 dispatch all resolve it here: when two of them
// read different keys or spellings, a call can be checked as one action and
// run as another.

import { ATLAS_TOOL_ACTIONS } from "../../../domains/atlas/functions/v2/contracts/tool-params.js";

/** Nested-action keys in the order they are resolved; the first present wins. */
export const ATLAS_NESTED_ACTION_KEYS = Object.freeze(["gatewayAction", "targetAction", "actionName"]);
// A provider-facing wrapper schema names its target `action`; inside dispatch
// `action` is the wrapper itself, so dispatch resolves without it.
const PROVIDER_NESTED_ACTION_KEYS = Object.freeze([...ATLAS_NESTED_ACTION_KEYS, "action"]);
const BLOCKED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);

const ACTION_BY_NORMALIZED_KEY = new Map(
  ATLAS_TOOL_ACTIONS.map((action) => [actionKey(action), action]),
);

const ACTION_ALIAS_BY_NORMALIZED_KEY = new Map([
  ["symbolgetcard", "symbol.card"],
  ["treewalk", "tree.branch"],
]);

/**
 * The camelCase field name dispatch reads for a snake_case argument key
 * (`gateway_action` and `gateway__action` both become `gatewayAction`).
 *
 * @param {string} key
 * @returns {string}
 */
export function atlasCallFieldName(key) {
  const name = String(key);
  if (!name.includes("_")) return name;
  return name.replace(/_+([a-zA-Z0-9])/g, (_match, char) => char.toUpperCase());
}

/**
 * Resolve an action string (including atlas_/atlas. prefixes, underscore and
 * case variants) to its canonical registered name, or return it stripped
 * when it names no registered action.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAtlasCallAction(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (raw))) return raw;
  const stripped = raw
    .replace(/^atlas[._-]/i, "")
    .replace(/^atlas_/i, "");
  const key = actionKey(stripped);
  return ACTION_ALIAS_BY_NORMALIZED_KEY.get(key) || ACTION_BY_NORMALIZED_KEY.get(key) || stripped;
}

/**
 * @param {string} action
 */
function actionKey(action) {
  return String(action || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * @param {unknown} args
 * @param {boolean} includeActionField
 * @returns {Map<string, { rawKeys: string[], value: unknown }>}
 */
function nestedActionFields(args, includeActionField) {
  const keys = includeActionField ? PROVIDER_NESTED_ACTION_KEYS : ATLAS_NESTED_ACTION_KEYS;
  const fields = new Map();
  if (!args || typeof args !== "object" || Array.isArray(args)) return fields;
  for (const [rawKey, value] of Object.entries(args)) {
    if (BLOCKED_FIELD_NAMES.has(rawKey)) continue;
    const key = atlasCallFieldName(rawKey);
    if (!keys.includes(key)) continue;
    // Dispatch keeps the first spelling of a field and drops the rest.
    const field = fields.get(key);
    if (field) field.rawKeys.push(rawKey);
    else fields.set(key, { rawKeys: [rawKey], value });
  }
  return fields;
}

/**
 * The canonical action a wrapper call routes to, or "" when it names none
 * that can be routed: missing, empty, or not a string (dispatch rejects the
 * last two). The result may still be an unknown or non-routable name; the
 * caller decides what it admits.
 *
 * @param {unknown} args
 * @param {{ includeActionField?: boolean }} [options] false inside dispatch,
 *   where `action` is the wrapper itself
 * @returns {string}
 */
export function atlasNestedAction(args, { includeActionField = true } = {}) {
  const fields = nestedActionFields(args, includeActionField);
  for (const key of includeActionField ? PROVIDER_NESTED_ACTION_KEYS : ATLAS_NESTED_ACTION_KEYS) {
    const field = fields.get(key);
    if (!field) continue;
    return typeof field.value === "string" ? normalizeAtlasCallAction(field.value) : "";
  }
  return "";
}

/**
 * Every argument key, in any spelling, that names a wrapper call's nested
 * action. Rewriting all of them is the only way to change what it routes to.
 *
 * @param {unknown} args
 * @param {{ includeActionField?: boolean }} [options]
 * @returns {string[]}
 */
export function atlasNestedActionArgKeys(args, { includeActionField = true } = {}) {
  return [...nestedActionFields(args, includeActionField).values()].flatMap((field) => field.rawKeys);
}
