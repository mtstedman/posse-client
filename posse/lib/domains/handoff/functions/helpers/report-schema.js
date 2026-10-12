// @ts-check

import { filterKnownHandoffFields } from "./field-diagnostics.js";

export function fail(code, message) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  throw err;
}

export function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function exactKeys(value, allowed, label) {
  const object = plainObject(value);
  if (!object) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label} must be an object`);
  const filtered = filterKnownHandoffFields(object, allowed, label);
  if (filtered) return filtered;
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) fail("AGENT_HANDOFF_SCHEMA_INVALID", `${label}.${key} is not allowed`);
  }
  return object;
}
