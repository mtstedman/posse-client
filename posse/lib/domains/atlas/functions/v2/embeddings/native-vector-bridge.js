// @ts-check

// Native semantic bridge: posse-atlas owns Jina query encoding and
// posse-atlas-vector owns ANN. Node only transports nearest hits into execute-tool.

import { openEmbeddingResources } from "./resources.js";
import {
  DOCUMENTATION_TEXT_SHAPE_VERSION,
  fuseEmbeddingChannelHits,
} from "./documentation-channel.js";

/**
 * @param {{
 *   query: string,
 *   limit?: number,
 *   candidateLimit?: number,
 *   repoRoot: string,
 *   config?: Record<string, unknown>,
 * }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   provider?: string,
 *   backend?: string,
 *   encoding?: {model:string, modelVersion:string, dim:number, channels?: {code:boolean, documentation:number}},
 *   candidateLimit?: number,
 *   hits: Array<{contentHash:string, localId:number, score:number, distance:number}>,
 * }>}
 */
export async function buildNativeVectorBridge({ query, limit = 50, candidateLimit, repoRoot, config = {} }) {
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
    const topK = Math.max(1, Math.min(
      candidateLimit == null
        ? Math.trunc(Number(limit) || 50) * 2
        : Math.trunc(Number(candidateLimit) || 1),
      1_000,
    ));
    const rawHits = await index.nearest(queryVector, {
      k: Math.min(1_000, Math.max(topK, topK * 6)),
      minScore: 0,
    });
    const hits = fuseEmbeddingChannelHits(rawHits, { k: topK, minScore: 0 });
    return {
      ok: true,
      provider: resources.provider,
      backend: resources.backend || undefined,
      candidateLimit: topK,
      encoding: {
        model: String(encoder.model || ""),
        modelVersion: String(encoder.model_version || ""),
        dim: encoder.dim,
        channels: { code: true, documentation: DOCUMENTATION_TEXT_SHAPE_VERSION },
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
