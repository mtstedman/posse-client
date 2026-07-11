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
 * @returns {Promise<string>}
 */
export async function redactSecrets(value) {
  return /** @type {string} */ (await runAtlasNativeOperationAsync({ op: "redact_secrets", value: String(value ?? "") }));
}

/**
 * Redact a batch of lines with ONE native call instead of one per line.
 * Token-shape patterns never span lines (file-read already redacts whole
 * joined windows on that assumption), so join/redact/split preserves the
 * line count; if it ever doesn't, fall back to per-line calls rather than
 * misalign text with line numbers.
 *
 * @param {string[]} lines
 * @returns {Promise<string[]>}
 */
export async function redactSecretsLines(lines) {
  const list = Array.isArray(lines) ? lines.map((line) => String(line ?? "")) : [];
  if (list.length === 0) return [];
  if (list.length === 1) return [await redactSecrets(list[0])];
  const redacted = (await redactSecrets(list.join("\n"))).split("\n");
  if (redacted.length !== list.length) {
    // Rare misalignment fallback: sequential per-line calls — the worker is
    // serial, so an unbounded fan-out would just queue anyway.
    const out = [];
    for (const line of list) out.push(await redactSecrets(line));
    return out;
  }
  return redacted;
}
