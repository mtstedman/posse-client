// @ts-check
//
// Lightweight output redaction shared by ATLAS v2 code/file retrieval.
// This is not a secret scanner; it catches common high-risk token shapes
// before raw windows are sent back to an agent. The pattern set lives in
// the native posse-atlas binary — the only implementation path, reached
// through the persistent worker.

import { runAtlasNativeOperationAsync } from "../native/invoke.js";

/**
 * @param {string} value
 * @param {{ repoRelPath: string, source: string, startLine: number }} [sourceContext]
 * @returns {Promise<string>}
 */
export async function redactSecrets(value, sourceContext) {
  return /** @type {string} */ (await runAtlasNativeOperationAsync({ op: "redact_secrets", value: String(value ?? ""), ...(sourceContext ? { sourceContext } : {}) }));
}

/**
 * Redact a batch of lines with ONE native call instead of one per line.
 * Source context lets native masking preserve multiline-value boundaries.
 * Older native implementations may still collapse lines; preserve the
 * existing fallback while forwarding each line's original source position.
 *
 * @param {string[]} lines
 * @param {{ repoRelPath: string, source: string, startLine: number }} [sourceContext]
 * @returns {Promise<string[]>}
 */
export async function redactSecretsLines(lines, sourceContext) {
  const list = Array.isArray(lines) ? lines.map((line) => String(line ?? "")) : [];
  if (list.length === 0) return [];
  if (list.length === 1) return [await redactSecrets(list[0], sourceContext)];
  const redacted = (await redactSecrets(list.join("\n"), sourceContext)).split("\n");
  if (redacted.length !== list.length) {
    // Rare misalignment fallback: sequential per-line calls — the worker is
    // serial, so an unbounded fan-out would just queue anyway.
    const out = [];
    for (const [index, line] of list.entries()) {
      out.push(await redactSecrets(line, sourceContext
        ? { ...sourceContext, startLine: sourceContext.startLine + index }
        : undefined));
    }
    return out;
  }
  return redacted;
}
