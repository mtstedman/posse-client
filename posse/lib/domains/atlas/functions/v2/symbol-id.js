// @ts-check

const ATLAS_SYMBOL_ID_RE = /^[0-9a-f]{64}:[0-9]+$/;

export function isAtlasSymbolId(value) {
  return typeof value === "string" && ATLAS_SYMBOL_ID_RE.test(value.trim());
}

export function parseAtlasSymbolId(value) {
  if (!isAtlasSymbolId(value)) return null;
  const text = String(value).trim();
  const idx = text.indexOf(":");
  return {
    content_hash: text.slice(0, idx),
    local_id: Number(text.slice(idx + 1)),
  };
}

export function atlasSymbolIdError(fieldName = "symbolId") {
  return `ATLAS ${fieldName} must be an opaque symbolId returned by ATLAS ` +
    "(<64-hex-content-hash>:<local_id>). Do not use file paths or symbol names; " +
    "call symbol.search first, or use symbolRef/file when the tool supports it.";
}

export function requireAtlasSymbolId(value, fieldName = "symbolId") {
  const candidate = String(value ?? "").trim();
  if (!isAtlasSymbolId(candidate)) {
    throw new Error(atlasSymbolIdError(fieldName));
  }
  return candidate;
}

export function optionalAtlasSymbolId(value, fieldName = "symbolId") {
  if (value == null || String(value).trim() === "") return null;
  return requireAtlasSymbolId(value, fieldName);
}

export function sanitizeAtlasSymbolIdList(values = [], maxItems = 30, fieldName = "symbolIds") {
  const list = Array.isArray(values) ? values : [];
  const out = [];
  for (const raw of list) {
    const candidate = requireAtlasSymbolId(raw, fieldName);
    if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= maxItems) break;
  }
  return out;
}
