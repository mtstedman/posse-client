// @ts-check
//
// Lightweight output redaction shared by ATLAS v2 code/file retrieval.
// This is not a secret scanner; it catches common high-risk token shapes
// before raw windows are sent back to an agent. The pattern set lives in
// the native posse-atlas binary — the only implementation path.

import { runAtlasNativeOperation, runAtlasNativeOperationAsync } from "../native/invoke.js";

/**
 * @param {string} value
 * @returns {string}
 */
export function redactSecrets(value) {
  return /** @type {string} */ (runAtlasNativeOperation({ op: "redact_secrets", value: String(value ?? "") }));
}

/**
 * @param {string} value
 * @returns {Promise<string>}
 */
export async function redactSecretsAsync(value) {
  return /** @type {string} */ (await runAtlasNativeOperationAsync({ op: "redact_secrets", value: String(value ?? "") }));
}

/**
 * Redact a batch of lines with ONE native call instead of one per line.
 * Each sync native call is a full process spawn since the sync bridge was
 * removed, so per-line redaction made a single match-window cost 5+ spawns
 * and a redaction-heavy retrieval 50-150. Token-shape patterns never span
 * lines (file-read already redacts whole joined windows on that assumption),
 * so join/redact/split preserves the line count; if it ever doesn't, fall
 * back to per-line calls rather than misalign text with line numbers.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
export function redactSecretsLines(lines) {
  const list = Array.isArray(lines) ? lines.map((line) => String(line ?? "")) : [];
  if (list.length === 0) return [];
  if (list.length === 1) return [redactSecrets(list[0])];
  const redacted = redactSecrets(list.join("\n")).split("\n");
  if (redacted.length !== list.length) return list.map((line) => redactSecrets(line));
  return redacted;
}

/**
 * @param {string[]} lines
 * @returns {Promise<string[]>}
 */
export async function redactSecretsLinesAsync(lines) {
  const list = Array.isArray(lines) ? lines.map((line) => String(line ?? "")) : [];
  if (list.length === 0) return [];
  if (list.length === 1) return [await redactSecretsAsync(list[0])];
  const redacted = (await redactSecretsAsync(list.join("\n"))).split("\n");
  if (redacted.length !== list.length) return await Promise.all(list.map((line) => redactSecretsAsync(line)));
  return redacted;
}
