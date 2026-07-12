// @ts-check

import path from "node:path";

import { nativeBinaries } from "../../../../shared/tools/classes/BinaryManager.js";

/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIngest} EmbeddingIngest */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingHit} EmbeddingHit */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingSearchOptions} EmbeddingSearchOptions */
/** @typedef {import("../../functions/v2/contracts/embeddings.js").EmbeddingIndex} EmbeddingIndexContract */

export const VECTOR_NATIVE_PROTOCOL = "posse.vector.native.v1";
export const VECTOR_NATIVE_ROUTE = "vector:methods";
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function encodeModelDirComponent(value) {
  return encodeURIComponent(String(value)).replace(/%/g, "~");
}

export function embeddingModelDirName({ model, model_version }) {
  return `${encodeModelDirComponent(model)}--${encodeModelDirComponent(model_version)}`;
}

/** @implements {EmbeddingIndexContract} */
export class RustEmbeddingIndex {
  /** @type {string} */ model;
  /** @type {string} */ model_version;
  /** @type {number} */ dim;
  /** @type {string} */ backend = "posse-vector";
  /** @type {true} */ asyncIndex = true;
  /** @type {true} */ childIndex = true;
  /** @type {string} */ gateKey;

  #embeddingsRoot;
  #annSaveEveryBatches;
  #annSaveEveryMs;
  #readOnly;
  #manager;
  #timeoutMs;
  #indexId = null;
  #opening = null;
  #closed = false;
  #lastAddTiming = null;

  constructor({
    model,
    model_version,
    dim,
    embeddingsRoot,
    annSaveEveryBatches,
    annSaveEveryMs,
    readOnly = false,
    manager = nativeBinaries,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }) {
    if (!model) throw new TypeError("RustEmbeddingIndex: model is required");
    if (!model_version) throw new TypeError("RustEmbeddingIndex: model_version is required");
    if (!Number.isInteger(dim) || dim <= 0) throw new RangeError("RustEmbeddingIndex: dim must be a positive integer");
    if (!embeddingsRoot) throw new TypeError("RustEmbeddingIndex: embeddingsRoot is required");
    this.model = model;
    this.model_version = model_version;
    this.dim = dim;
    this.#embeddingsRoot = embeddingsRoot;
    this.#annSaveEveryBatches = annSaveEveryBatches;
    this.#annSaveEveryMs = annSaveEveryMs;
    this.#readOnly = !!readOnly;
    this.#manager = manager;
    this.#timeoutMs = timeoutMs;
    this.gateKey = `posse-vector:${path.join(embeddingsRoot, embeddingModelDirName({ model, model_version }))}`;
  }

  static open(args) {
    return new RustEmbeddingIndex(args);
  }

  async #ensureOpen() {
    if (this.#closed) throw stateError("RustEmbeddingIndex: closed");
    if (this.#indexId) return;
    if (this.#opening) return await this.#opening;
    this.#opening = this.#invoke("vector.open", {
      embeddingsRoot: this.#embeddingsRoot,
      model: this.model,
      modelVersion: this.model_version,
      dim: this.dim,
      readOnly: this.#readOnly,
      ...(this.#annSaveEveryBatches == null ? {} : { annSaveEveryBatches: this.#annSaveEveryBatches }),
      ...(this.#annSaveEveryMs == null ? {} : { annSaveEveryMs: this.#annSaveEveryMs }),
    }).then((data) => {
      const indexId = String(data?.indexId || "");
      if (!indexId) throw protocolError("vector.open did not return indexId");
      this.#indexId = indexId;
    }).finally(() => { this.#opening = null; });
    return await this.#opening;
  }

  async #request(method, payload = {}, { retry = true } = {}) {
    await this.#ensureOpen();
    try {
      return await this.#invoke(method, { indexId: this.#indexId, ...payload });
    } catch (error) {
      if (!retry || !recoverableSessionError(error)) throw error;
      this.#indexId = null;
      await this.#ensureOpen();
      return await this.#invoke(method, { indexId: this.#indexId, ...payload });
    }
  }

  async #invoke(method, payload) {
    if (!this.#manager.shouldUse("vector")) throw unavailableError(method);
    const request = { protocol: VECTOR_NATIVE_PROTOCOL, method, payload };
    const result = await this.#manager.binary("vector").run(method, [], {
      input: `${JSON.stringify(request)}\n`,
      json: true,
      timeoutMs: this.#timeoutMs,
      worker: true,
      workerFallback: false,
      requiredRoute: VECTOR_NATIVE_ROUTE,
    });
    if (!result.ok) {
      const error = new Error(String(result.stderr || result.error?.message || `vector method ${method} failed`));
      /** @type {any} */ (error).code = /** @type {any} */ (result.error)?.code || "VECTOR_NATIVE_PROCESS_FAILED";
      throw error;
    }
    const frame = result.json;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw protocolError(`${method} returned an invalid response`);
    if (frame.ok === false) {
      const error = new Error(String(frame.error?.message || `${method} failed`));
      /** @type {any} */ (error).code = String(frame.error?.code || "VECTOR_NATIVE_ERROR");
      throw error;
    }
    if (frame.ok !== true || !Object.prototype.hasOwnProperty.call(frame, "data")) {
      throw protocolError(`${method} returned an invalid response envelope`);
    }
    return frame.data;
  }

  add(rows) {
    const payloadRows = (Array.isArray(rows) ? rows : []).map((row) => ({
      contentHash: row?.content_hash,
      localId: row?.local_id,
      vectorB64: vectorB64(row?.vector, this.dim, "RustEmbeddingIndex.add"),
    }));
    return this.#request("vector.add", { rows: payloadRows }).then((data) => {
      this.#lastAddTiming = data?.timing && typeof data.timing === "object" ? data.timing : null;
    });
  }

  removeByContentHash(content_hashes) {
    return this.#request("vector.removeByContentHash", {
      contentHashes: Array.isArray(content_hashes) ? content_hashes : [],
    }).then((data) => Number(data?.removed || 0));
  }

  pruneToKeys(keys) {
    return this.#request("vector.pruneToKeys", { keys: wireKeys(keys) })
      .then((data) => Number(data?.removed || 0));
  }

  contains(content_hash, local_id) {
    return this.containsMany([{ content_hash, local_id }]).then((present) => present.has(`${content_hash}\0${local_id}`));
  }

  containsMany(keys) {
    return this.#request("vector.containsMany", { keys: wireKeys(keys) }).then((data) => new Set(
      (Array.isArray(data?.present) ? data.present : []).map((item) => `${item.contentHash}\0${item.localId}`),
    ));
  }

  getLastAddTiming() {
    return this.#lastAddTiming ? { ...this.#lastAddTiming } : null;
  }

  getEmbeddingWatermark(key) {
    return this.#request("vector.watermark.get", { key: String(key || "") }).then((data) => data?.watermark ?? null);
  }

  setEmbeddingWatermark(key, watermark) {
    return this.#request("vector.watermark.set", {
      key: String(key || ""),
      watermark: watermark && typeof watermark === "object" ? watermark : {},
    }).then(() => undefined);
  }

  nearest(vector, opts = {}) {
    const restrict = opts?.restrictToContentHashes instanceof Set
      ? Array.from(opts.restrictToContentHashes)
      : Array.isArray(opts?.restrictToContentHashes) ? opts.restrictToContentHashes : null;
    return this.#request("vector.nearest", {
      vectorB64: vectorB64(vector, this.dim, "RustEmbeddingIndex.nearest"),
      ...(opts?.k == null ? {} : { k: opts.k }),
      ...(opts?.minScore == null ? {} : { minScore: opts.minScore }),
      ...(restrict == null ? {} : { restrictToContentHashes: restrict.map(String) }),
    }).then((data) => (Array.isArray(data?.hits) ? data.hits : []).map((hit) => ({
      content_hash: hit.contentHash,
      local_id: hit.localId,
      score: hit.score,
      distance: hit.distance,
    })));
  }

  count() {
    return this.#request("vector.count").then((data) => Number(data?.count || 0));
  }

  markEncoding(keys, meta = {}) {
    return this.#request("vector.inflight.mark", { keys: wireKeys(keys), meta }).then(() => undefined);
  }

  clearEncoding() {
    return this.#request("vector.inflight.clear").then(() => undefined);
  }

  readInflight() {
    return this.#request("vector.inflight.read").then((data) => data?.inflight ?? null);
  }

  async close() {
    if (this.#closed) return;
    const indexId = this.#indexId;
    this.#closed = true;
    this.#indexId = null;
    if (!indexId) return;
    try {
      await this.#invoke("vector.close", { indexId });
    } catch (error) {
      if (!recoverableSessionError(error)) throw error;
    }
  }
}

function wireKeys(keys) {
  return (Array.isArray(keys) ? keys : []).map((item) => ({
    contentHash: item?.content_hash,
    localId: item?.local_id,
  }));
}

function vectorB64(vector, dim, label) {
  if (!(vector instanceof Float32Array) || vector.length !== dim) {
    throw new RangeError(`${label}: vector must be Float32Array of length ${dim}; got length ${vector?.length}`);
  }
  const bytes = Buffer.allocUnsafe(dim * 4);
  for (let i = 0; i < dim; i += 1) {
    if (!Number.isFinite(vector[i])) throw new RangeError(`${label}: vector contains non-finite value at index ${i}`);
    bytes.writeFloatLE(vector[i], i * 4);
  }
  return bytes.toString("base64");
}

function recoverableSessionError(error) {
  const code = String(error?.code || "");
  return code === "invalid_state" || code === "POSSE_NATIVE_WORKER_UNAVAILABLE";
}

function unavailableError(method) {
  const error = new Error(`vector native method unavailable: ${method}`);
  /** @type {any} */ (error).code = "VECTOR_NATIVE_UNAVAILABLE";
  return error;
}

function protocolError(message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = "VECTOR_NATIVE_PROTOCOL_SKEW";
  return error;
}

function stateError(message) {
  const error = new Error(message);
  /** @type {any} */ (error).code = "invalid_state";
  return error;
}
