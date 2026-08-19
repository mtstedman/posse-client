import { UNBOUNDED_COMMAND_TIMEOUT_VALUES } from "../../../catalog/process.js";

const UNBOUNDED_COMMAND_TIMEOUT_SET = new Set(UNBOUNDED_COMMAND_TIMEOUT_VALUES);

export function isUnboundedCommandTimeout(value) {
  return value === null
    || value === false
    || (typeof value === "string" && UNBOUNDED_COMMAND_TIMEOUT_SET.has(value.trim().toLowerCase()));
}

/**
 * @param {NodeJS.ProcessEnv} [sourceEnv]
 * @param {{ allowedKeys?: readonly string[], allowedPrefixes?: readonly string[] }} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function filterProcessEnv(sourceEnv = process.env, {
  allowedKeys = [],
  allowedPrefixes = [],
} = {}) {
  const allowed = new Set(allowedKeys.map((key) => String(key).toLowerCase()));
  const prefixes = allowedPrefixes.map((prefix) => String(prefix).toLowerCase());
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv || {})) {
    if (value == null) continue;
    const normalizedKey = String(key).toLowerCase();
    if (!allowed.has(normalizedKey) && !prefixes.some((prefix) => normalizedKey.startsWith(prefix))) continue;
    env[key] = String(value);
  }
  return env;
}
