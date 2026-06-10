// @ts-check
//
// Lightweight output redaction shared by ATLAS v2 code/file retrieval.
// This is not a secret scanner; it catches common high-risk token shapes
// before raw windows are sent back to an agent.

import { runAtlasNativeOperation } from "../native/invoke.js";
import { nativeBinaries } from "../../../../../classes/tools/BinaryManager.js";

const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[^"'\s]{12,}/gi,
]);

/**
 * @param {string} value
 * @returns {string}
 */
export function redactSecrets(value) {
  if (nativeBinaries.shouldUse("atlas")) {
    return /** @type {string} */ (runAtlasNativeOperation({ op: "redact_secrets", value: String(value ?? "") }));
  }
  return redactSecretsNode(value);
}

/** @param {string} value @returns {string} */
function redactSecretsNode(value) {
  let out = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const idx = match.search(/[:=]/);
      if (idx >= 0) return `${match.slice(0, idx + 1)} <redacted>`;
      return "<redacted>";
    });
  }
  return out;
}
