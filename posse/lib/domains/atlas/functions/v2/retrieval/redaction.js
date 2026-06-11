// @ts-check
//
// Lightweight output redaction shared by ATLAS v2 code/file retrieval.
// This is not a secret scanner; it catches common high-risk token shapes
// before raw windows are sent back to an agent. The pattern set lives in
// the native posse-atlas binary — the only implementation path.

import { runAtlasNativeOperation } from "../native/invoke.js";

/**
 * @param {string} value
 * @returns {string}
 */
export function redactSecrets(value) {
  return /** @type {string} */ (runAtlasNativeOperation({ op: "redact_secrets", value: String(value ?? "") }));
}
