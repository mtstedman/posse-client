// @ts-check
//
// Embedding search — encode a query string and run a top-k lookup
// against an EmbeddingIndex, then resolve hits back to ViewSymbol rows
// via (content_hash, local_id).

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/embeddings.js").EmbeddingEncoder} EmbeddingEncoder */
/** @typedef {import("../contracts/embeddings.js").EmbeddingIndex} EmbeddingIndex */
/** @typedef {import("../contracts/embeddings.js").EmbeddingHit} EmbeddingHit */

/**
 * @typedef {Object} SemanticHit
 * @property {ViewSymbol} symbol
 * @property {number} score        In [0, 1]; higher = closer.
 * @property {number} distance     Raw cosine distance from the ANN.
 */

/**
 * @param {{
 *   query: string,
 *   view: View,
 *   index: EmbeddingIndex,
 *   encoder: EmbeddingEncoder,
 *   k?: number,
 *   minScore?: number,
 *   signal?: AbortSignal,
 * }} args
 * @returns {Promise<SemanticHit[]>}
 */
export async function semanticSearch({ query, view, index, encoder, k, minScore, signal }) {
  if (typeof query !== "string" || query.length === 0) {
    throw new TypeError("semanticSearch: non-empty query is required");
  }
  if (!view || !index || !encoder) {
    throw new TypeError("semanticSearch: view, index, and encoder are required");
  }
  if (encoder.dim !== index.dim) {
    throw new RangeError(
      `semanticSearch: encoder dim ${encoder.dim} != index dim ${index.dim}`,
    );
  }
  const topK = Math.max(1, Math.min(Number.isInteger(k) ? /** @type {number} */ (k) : 20, 200));
  const minS = typeof minScore === "number" ? minScore : 0;
  const queryVector = typeof encoder.encodeQuery === "function"
    ? await encoder.encodeQuery(query, signal)
    : (await encoder.encode([query], signal))?.[0];
  if (!(queryVector instanceof Float32Array) || queryVector.length !== encoder.dim) {
    throw new Error("semanticSearch: encoder returned no valid vector for query");
  }
  const hits = await index.nearest(queryVector, { k: topK, minScore: minS });

  /** @type {SemanticHit[]} */
  const out = [];
  for (const h of hits) {
    const sym = await view.query.getByContentLocal(h.content_hash, h.local_id);
    if (!sym) continue; // Embedding referenced a blob that's not in this view.
    out.push({ symbol: sym, score: h.score, distance: h.distance });
  }
  return out;
}
