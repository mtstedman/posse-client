// @ts-check

import { sha256Hex } from "./hash.js";

export function streamEmbeddingSymbol(symbol) {
  const contentHash = String(symbol?.content_hash || "");
  const localId = Number(symbol?.local_id);
  const fingerprint = sha256Hex(JSON.stringify({
    content_hash: contentHash,
    local_id: localId,
    kind: symbol?.kind ?? null,
    name: symbol?.name ?? null,
    qualified_name: symbol?.qualified_name ?? null,
    signature_hash: symbol?.signature_hash ?? null,
    signature_text: symbol?.signature_text ?? null,
    doc: symbol?.doc ?? null,
    source: symbol?.source ?? null,
  }));
  return {
    ...symbol,
    content_hash: contentHash,
    local_id: localId,
    symbol_key: `${contentHash}\0${localId}`,
    merged_fingerprint: fingerprint,
  };
}

export async function symbolsMissingFromEmbeddingIndex(index, symbols) {
  const keys = symbols.map((symbol) => ({
    content_hash: symbol.content_hash,
    local_id: symbol.local_id,
  }));
  if (typeof index?.containsMany === "function") {
    try {
      const result = await index.containsMany(keys);
      const present = result instanceof Set
        ? result
        : Array.isArray(result) ? new Set(result.map(String)) : new Set();
      return symbols.filter((symbol) => !present.has(symbol.symbol_key));
    } catch { /* fall through to scalar checks */ }
  }
  if (typeof index?.contains !== "function") return symbols;
  const missing = [];
  for (const symbol of symbols) {
    let present = false;
    try { present = !!(await index.contains(symbol.content_hash, symbol.local_id)); }
    catch { present = false; }
    if (!present) missing.push(symbol);
  }
  return missing;
}

export function embeddingIndexRow(row) {
  const symbolKey = String(row?.symbol_key || "");
  const separator = symbolKey.lastIndexOf("\0");
  if (separator <= 0) throw new Error(`invalid streaming embedding symbol key '${symbolKey}'`);
  const contentHash = symbolKey.slice(0, separator);
  const localId = Number(symbolKey.slice(separator + 1));
  if (!Number.isInteger(localId)) throw new Error(`invalid streaming embedding local id '${symbolKey}'`);
  return {
    content_hash: contentHash,
    local_id: localId,
    vector: row.vector,
  };
}
