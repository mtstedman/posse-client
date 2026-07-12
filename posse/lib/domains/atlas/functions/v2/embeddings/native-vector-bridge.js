// @ts-check

// Native semantic bridge: posse-atlas owns Jina query encoding and
// posse-vector owns ANN. Node only transports nearest hits into execute-tool.

import { openEmbeddingResources } from "./resources.js";

/**
 * @param {{
 *   query: string,
 *   limit?: number,
 *   repoRoot: string,
 *   config?: Record<string, unknown>,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   provider?: string,
 *   backend?: string,
 *   encoding?: {model:string, modelVersion:string, dim:number},
 *   hits: Array<{contentHash:string, localId:number, score:number, distance:number}>,
 * }>}
 */
export async function buildNativeVectorBridge({ query, limit = 50, repoRoot, config = {} }) {
  const resources = openEmbeddingResources({ repoRoot, config, readOnly: true });
  try {
    if (!resources?.enabled || !resources.encoder || !resources.index) {
      return {
        ok: false,
        reason: String(resources?.reason || "unavailable"),
        provider: String(resources?.provider || "") || undefined,
        backend: String(resources?.backend || "") || undefined,
        hits: [],
      };
    }
    const { encoder, index } = resources;
    const nativeEncoder = /** @type {any} */ (encoder);
    if (encoder.dim !== index.dim) {
      return {
        ok: false,
        reason: "dim_mismatch",
        provider: resources.provider,
        backend: resources.backend || undefined,
        hits: [],
      };
    }
    const queryVector = typeof nativeEncoder.encodeQuery === "function"
      ? await nativeEncoder.encodeQuery(String(query || ""))
      : (await encoder.encode([String(query || "")]))?.[0];
    if (!(queryVector instanceof Float32Array)) {
      return {
        ok: false,
        reason: "encode_error",
        provider: resources.provider,
        backend: resources.backend || undefined,
        hits: [],
      };
    }
    const topK = Math.max(1, Math.min(Math.trunc(Number(limit) || 50) * 2, 1_000));
    const hits = await index.nearest(queryVector, { k: topK, minScore: 0 });
    return {
      ok: true,
      provider: resources.provider,
      backend: resources.backend || undefined,
      encoding: {
        model: String(encoder.model || ""),
        modelVersion: String(encoder.model_version || ""),
        dim: encoder.dim,
      },
      hits: (Array.isArray(hits) ? hits : []).map((hit) => ({
        contentHash: String(hit.content_hash || ""),
        localId: Number(hit.local_id),
        score: Number(hit.score),
        distance: Number(hit.distance),
      })),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `bridge_error: ${error instanceof Error ? error.message : String(error)}`,
      provider: String(resources?.provider || "") || undefined,
      backend: String(resources?.backend || "") || undefined,
      hits: [],
    };
  } finally {
    await resources?.close?.();
  }
}
