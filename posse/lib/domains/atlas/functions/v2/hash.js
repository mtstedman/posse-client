// @ts-check
//
// Content-hash helpers for ATLAS v2. SHA-256 hex, lowercase, no truncation.
// Used to compute `content_hash` in SymbolRow and EdgeRow.

import { createHash } from "crypto";

/**
 * @param {Buffer | string} bytes
 * @returns {string}                 64-char lowercase hex.
 */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** RegExp matching a valid SHA-256 hex digest. Use at trust boundaries. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isContentHash(value) {
  return typeof value === "string" && SHA256_HEX_RE.test(value);
}
