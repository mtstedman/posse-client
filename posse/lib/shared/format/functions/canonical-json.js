// @ts-check

// These contracts preserve existing persisted hash/signature bytes. They are
// deliberately separate and are not replacements for strict JSON.stringify.

/**
 * Sorted object keys, with unsupported primitive values encoded as null.
 * Arrays retain map/join semantics, including sparse slots.
 * @param {any} value
 * @returns {string}
 */
export function canonicalJsonNullFallback(value) {
  if (value === null) return "null";
  if (["string", "number", "boolean"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonNullFallback).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonNullFallback(value[key])}`).join(",")}}`;
  }
  return "null";
}

/**
 * Sorted object keys, with JSON.stringify's primitive result retained.
 * Undefined object fields encode the literal undefined; undefined array slots
 * join as empty entries. BigInt throws, as it did in the original callers.
 * @param {any} value
 * @returns {string | undefined}
 */
export function canonicalJsonNativePrimitives(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonNativePrimitives).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonNativePrimitives(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
