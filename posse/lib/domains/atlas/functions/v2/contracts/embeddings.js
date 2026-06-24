// @ts-check
//
// Embedding contracts for v1. Workstream H owns the implementation.
//
// Design summary:
//   * Embeddings are content-addressed by (content_hash, local_id), the
//     same identity used for SymbolRow. Once a blob's symbols are
//     embedded under a given (model, model_version), the result is
//     immutable and shareable across worktrees.
//   * One embedding store per ledger lives at <repo>/.posse/atlas/embeddings/
//     containing both the on-disk vector blobs and an ANN index per
//     (model, model_version) tuple.
//   * The view layer doesn't store embeddings — it stores references into
//     the embedding store. View rebuild does not re-embed.
//
// Library choice (deferred to Workstream H — picking the library is the
// first sub-task of H, NOT this contract):
//   * hnswlib-node — common, native, well-tested, but Windows native
//     builds can be fragile.
//   * usearch      — newer, native, faster build story, smaller surface.
//   * Pure-JS HNSW — fully portable, slower; viable for repos < 100k symbols.
// rules.md requires explicit user discussion before adding a native dep.

/**
 * One embedding row, content-addressed alongside its source symbol.
 *
 * @typedef {Object} EmbeddingRow
 * @property {string} content_hash            Matches SymbolRow.content_hash.
 * @property {number} local_id                Matches SymbolRow.local_id.
 * @property {string} model                   Stable model identifier, e.g. "all-minilm-l6-v2".
 * @property {string} model_version           Model version string for cache busting.
 * @property {number} dim                     Vector dimensionality.
 * @property {Float32Array} vector            Length === dim.
 * @property {string} created_at              ISO-8601.
 */

/**
 * One nearest-neighbor hit. Symbol identity is by (content_hash, local_id)
 * so the caller can join into the view's symbols table for display data.
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
 * @property {(symbols: EmbeddingSymbolInput[], signal?: AbortSignal) => Promise<Float32Array[]>} [encodeSymbols]
 *   Optional structured-symbol batch encode. Remote ATLAS encoders use this to
 *   keep canonicalization server-side; local encoders may omit it and rely on
 *   buildSymbolText + encode.
 *
 * @property {(symbol: EmbeddingSymbolInput) => string} buildSymbolText
 *   Canonicalize the text representation of a symbol used for embedding.
 *   Concrete implementations decide what to include (name, qualified
 *   name, signature, doc, ...) — but the function must be deterministic
 *   so the same symbol always produces the same input string under the
 *   same encoder version.
 */
