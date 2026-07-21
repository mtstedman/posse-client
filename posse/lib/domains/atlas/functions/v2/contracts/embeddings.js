// @ts-check
//
// Embedding contracts for v1. Workstream H owns the implementation.
//
// Design summary:
//   * Code embeddings are content-addressed by (content_hash, local_id), the
//     same identity used for SymbolRow. Documentation embeddings share the
//     physical store under a versioned opaque key that carries the source hash
//     plus an independent documentation-text fingerprint.
//   * One embedding store per ledger lives at <repo>/.posse/atlas/embeddings/
//     containing both the on-disk vector blobs and an ANN index per
//     (model, model_version) tuple.
//   * The view layer doesn't store embeddings — it stores references into
//     the embedding store. View rebuild does not re-embed.
//
// Runtime ownership is fixed: posse-ml encodes and posse-atlas-vector stores and
// searches the ANN. Node implements only this transport-neutral data contract.

/**
 * One embedding row, content-addressed alongside its source symbol.
 *
 * @typedef {Object} EmbeddingRow
 * @property {string} content_hash            Code: SymbolRow.content_hash. Documentation: versioned opaque channel key.
 * @property {number} local_id                Matches SymbolRow.local_id.
 * @property {string} model                   Stable model identifier, e.g. "all-minilm-l6-v2".
 * @property {string} model_version           Model version string for cache busting.
 * @property {number} dim                     Vector dimensionality.
 * @property {Float32Array} vector            Length === dim.
 * @property {string} created_at              ISO-8601.
 */

/**
 * One nearest-neighbor hit. Raw documentation-channel hits use an opaque
 * content_hash and must be decoded/fused before joining into the view.
 *
 * @typedef {Object} EmbeddingHit
 * @property {string} content_hash
 * @property {number} local_id
 * @property {number} score                   Similarity in [0, 1]; higher = closer.
 * @property {number} distance                Raw distance (cosine or L2); lower = closer.
 */

/**
 * @typedef {Object} EmbeddingIngest
 * @property {string} content_hash
 * @property {number} local_id
 * @property {Float32Array} vector
 */

/**
 * @typedef {Object} EmbeddingSearchOptions
 * @property {number} [k]                     Default 20.
 * @property {Set<string>} [restrictToContentHashes]   Filter results to a path-derived blob set.
 * @property {number} [minScore]              0..1. Drop hits below this similarity.
 */

/**
 * Per-(model, model_version) ANN index. Phase 1 stores one of these per
 * model the deployment uses. Implementations may share the underlying
 * file when multiple consumers point at the same model.
 *
 * @typedef {Object} EmbeddingIndex
 *
 * @property {string} model
 * @property {string} model_version
 * @property {number} dim
 * @property {number | null} [batchSize]
 * @property {number | null} [intraOpThreads]
 *
 * @property {string} [backend]
 * @property {boolean} [asyncIndex]
 *
 * @property {(rows: EmbeddingIngest[]) => void | Promise<void>} add
 *   Insert vectors. Idempotent per (content_hash, local_id): the second
 *   call is a no-op. Caller is responsible for ensuring `rows` were
 *   produced by the matching `(model, model_version)`.
 *
 * @property {(content_hashes: string[]) => number | Promise<number>} removeByContentHash
 *   Drop every row whose source blob is in the list. Returns the count of
 *   source-of-truth sidecar rows removed; ANN removals are best-effort and
 *   stale ANN ids are filtered by sidecar lookup at read time. Called by
 *   Workstream A when a blob is garbage-collected
 *   (rare — blobs are immutable, but unreferenced blobs eventually GC).
 *
 * @property {(content_hash: string, local_id: number) => boolean | Promise<boolean>} [contains]
 *   Return true when the exact symbol vector is already present. Used by
 *   on-demand WI semantic search to encode only missing symbols.
 *
 * @property {(keys: Array<{ content_hash: string, local_id: number }>) => Set<string> | string[] | Promise<Set<string> | string[]>} [containsMany]
 *   Batched membership probe. Returned set uses `${content_hash}\0${local_id}`
 *   keys and should match `contains` semantics.
 *
 * @property {() => (Record<string, any> | null)} [getLastAddTiming]
 *   Optional diagnostic metadata for the most recent add call. Used only for
 *   boot/intake telemetry.
 *
 * @property {(key: string) => Record<string, any> | null | Promise<Record<string, any> | null>} [getEmbeddingWatermark]
 *   Optional per-view parity watermark stored with the embedding sidecar.
 *
 * @property {(key: string, watermark: Record<string, any>) => void | Promise<void>} [setEmbeddingWatermark]
 *   Persist a per-view parity watermark after successful ingest/prune.
 *
 * @property {(keys: Array<{ content_hash: string, local_id: number }>) => number | Promise<number>} [pruneToKeys]
 *   Drop rows not present in the supplied current-view key set. Used after a
 *   successful warm to self-heal orphan rows left by interrupted or rebuilt
 *   views.
 *
 * @property {(keys: Array<{ content_hash: string, local_id: number }>, meta?: Record<string, any>) => void | Promise<void>} [markEncoding]
 *   Persist a crash-recovery breadcrumb before an encode batch begins.
 *
 * @property {() => void | Promise<void>} [clearEncoding]
 *   Clear the crash-recovery breadcrumb after its rows commit.
 *
 * @property {() => Record<string, any> | null | Promise<Record<string, any> | null>} [readInflight]
 *   Read an interrupted encode breadcrumb during reconciliation.
 *
 * @property {(vector: Float32Array, opts?: EmbeddingSearchOptions) => EmbeddingHit[] | Promise<EmbeddingHit[]>} nearest
 *   Top-k by cosine similarity. Vector must have length === dim.
 *
 * @property {() => number | Promise<number>} count
 *
 * @property {() => void | Promise<void>} close
 */

/**
 * Minimum shape `buildSymbolText` consumes. SymbolRow (raw parse output)
 * and ViewSymbol (denormalized read-side row) both satisfy this — the
 * encoder doesn't care which side fed it.
 *
 * @typedef {Object} EmbeddingSymbolInput
 * @property {string} kind
 * @property {string} lang
 * @property {string} name
 * @property {string | null} qualified_name
 * @property {string} signature_hash
 * @property {string | null} [signature_text]
 * @property {string | null} [doc]        Doc comment / docstring, if present.
 *   Canonical code embedding text excludes this field; the documentation
 *   channel embeds it independently.
 * @property {string | null} [body_lead]  Leading slice of the symbol body
 *   (e.g. first ~5 lines). Optional — `ingestView` populates it when
 *   `repoRoot` is supplied so the encoder has natural-language vocabulary
 *   from the body, not just the identity card.
 */

/**
 * Encoder that turns a symbol or query text into a vector. Implementations
 * may be local (transformers.js, ONNX runtime) or remote (provider API);
 * the contract is the same.
 *
 * @typedef {Object} EmbeddingEncoder
 *
 * @property {string} model
 * @property {string} model_version
 * @property {number} dim
 *
 * @property {(texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>} encode
 *   Batch encode. Returns one Float32Array per input.
 *
 * @property {(texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>} [encodeDocuments]
 *   Optional document-specific batch encoding.
 *
 * @property {(text: string, signal?: AbortSignal) => Promise<Float32Array>} [encodeQuery]
 *   Optional query-specific encoding. Semantic search prefers this when present.
 *
 * @property {(symbols: EmbeddingSymbolInput[], signal?: AbortSignal) => Promise<Float32Array[]>} [encodeSymbols]
 *   Optional structured-symbol batch encode. Remote ATLAS encoders use this to
 *   keep canonicalization server-side; local encoders may omit it and rely on
 *   buildSymbolText + encode.
 *
 * @property {(symbol: EmbeddingSymbolInput) => string} buildSymbolText
 *   Canonicalize the text representation of a symbol used for embedding.
 *   Concrete implementations decide what to include (name, qualified
 *   name, signature, body lead, ...) — but the function must be deterministic
 *   so the same symbol always produces the same input string under the
 *   same encoder version.
 *
 * @property {() => void | Promise<void>} [dispose]
 *   Release encoder-owned runtime resources when present.
 */
