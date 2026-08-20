// Canonical normalization for Atlas source-identifier inputs. Indexed symbol
// displays may use parser markers that are not valid code.window/code.lens
// anchors; every producer and contract boundary must use this translation.

const ATLAS_IDENTIFIER_MAX_CHARS = 128;
const ATLAS_IDENTIFIER_RE = /^[A-Za-z0-9_$.:/#-]+$/u;
const ATLAS_DISPLAY_IDENTIFIER_ALIASES = new Map([
  ["<constructor>", "constructor"],
]);

function identifierInputList(values) {
  if (Array.isArray(values)) return values;
  if (typeof values !== "string") return [];
  const text = values.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to legacy scalar splitting.
    }
  }
  return text.split(/[\s,;]+/u).filter(Boolean);
}

export function normalizeAtlasIdentifier(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const aliased = ATLAS_DISPLAY_IDENTIFIER_ALIASES.get(raw.toLowerCase()) || raw;
  const bounded = aliased.slice(0, ATLAS_IDENTIFIER_MAX_CHARS);
  return ATLAS_IDENTIFIER_RE.test(bounded) ? bounded : "";
}

export function normalizeAtlasIdentifierList(values, maxItems = 8) {
  const limit = Math.max(0, Math.floor(Number(maxItems) || 0));
  if (limit === 0) return [];
  const out = [];
  for (const raw of identifierInputList(values)) {
    const identifier = normalizeAtlasIdentifier(raw);
    if (!identifier || out.includes(identifier)) continue;
    out.push(identifier);
    if (out.length >= limit) break;
  }
  return out;
}
