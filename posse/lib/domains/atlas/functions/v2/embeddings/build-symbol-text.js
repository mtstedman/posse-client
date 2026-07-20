// @ts-check
//
// Shared canonical text representation for ATLAS symbol embeddings.
// Keep this module small and dependency-free so every encoder can use the
// same text shape without pulling in encoder/runtime dependencies.

/** @typedef {import("../contracts/embeddings.js").EmbeddingSymbolInput} EmbeddingSymbolInput */

export const TEXT_SHAPE_VERSION = 4;

/** Cap body lead at 400 chars (first ~5 lines is usually enough). */
const BODY_LEAD_CAP = 400;
/** Cap raw signature text at 200 chars; parser already truncates here. */
const SIGNATURE_TEXT_CAP = 200;

/**
 * Normalize a long free-form string into the encoder's input format: collapse
 * whitespace and cap length so output stays deterministic and bounded.
 *
 * @param {unknown} text
 * @param {number} cap
 * @returns {string}
 */
export function compactEmbeddingExcerpt(text, cap) {
  if (text == null) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

/**
 * Canonical text representation used to embed a symbol. Order is fixed
 * so the same symbol always produces the same input string under the
 * same text-shape version.
 *
 * @param {EmbeddingSymbolInput} symbol
 * @returns {string}
 */
export function defaultBuildSymbolText(symbol) {
  if (!symbol || typeof symbol.name !== "string") {
    throw new TypeError("buildSymbolText: symbol with .name is required");
  }
  const parts = [
    symbol.kind,
    symbol.lang,
    symbol.qualified_name || symbol.name,
    compactEmbeddingExcerpt(symbol.signature_text, SIGNATURE_TEXT_CAP),
    compactEmbeddingExcerpt(symbol.body_lead, BODY_LEAD_CAP),
  ];
  return parts.filter((p) => typeof p === "string" && p.length > 0).join(" § ");
}
