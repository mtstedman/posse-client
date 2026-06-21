// @ts-check
//
// Native SCIP -> ATLAS row conversion. JS remains responsible for ledger
// writes and external-symbol persistence; Rust owns the symbol/edge derivation.

import { runAtlasNativeMethodAsync } from "../native/invoke.js";

/**
 * @param {{ index: Record<string, any>, timeoutMs?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function scipIndexToRowsNative({ index, timeoutMs = 120_000 } = {}) {
  if (!index || typeof index !== "object") {
    throw new TypeError("scipIndexToRowsNative: index is required");
  }
  return /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("scip-rows", {
    index: scipIndexForNative(index),
    assignExternalIds: true,
  }, {
    timeoutMs,
  }));
}

export function __testScipIndexForNative(index) {
  return scipIndexForNative(index);
}

function scipIndexForNative(index) {
  const documents = Array.isArray(index.documents) ? index.documents.map((document) => {
    const doc = document && typeof document === "object" ? document : {};
    const { source_bytes, sourceBytes, ...rest } = doc;
    if (!rest.text && sourceByteLength(source_bytes ?? sourceBytes) === 0) {
      return { ...rest, source_bytes: [] };
    }
    return rest;
  }) : [];
  return {
    ...index,
    documents,
  };
}

function sourceByteLength(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object" && Array.isArray(value.data)) return value.data.length;
  return null;
}
