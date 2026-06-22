// @ts-check

export { RemoteAtlasEncoderClient } from "../classes/RemoteAtlasEncoderClient.js";

export const REMOTE_ATLAS_ENCODER_PATH = "/v1/atlas/embeddings/encode";
export const DEFAULT_REMOTE_ATLAS_ENCODER_TIMEOUT_MS = 30000;
export const REMOTE_ATLAS_ENCODER_SYMBOL_EGRESS_FIELDS = Object.freeze([
  "content_hash",
  "local_id",
  "repo_rel_path",
  "kind",
  "lang",
  "name",
  "qualified_name",
  "signature_hash",
  "signature_text",
  "doc",
  "body_lead",
]);
export const REMOTE_ATLAS_ENCODER_QUERY_EGRESS_FIELDS = Object.freeze(["texts"]);
export const REMOTE_ATLAS_ENCODER_EGRESS_POLICY = Object.freeze({
  channel: "atlas_embeddings_encode",
  source_policy: "source_derived_symbol_text",
  symbol_fields: REMOTE_ATLAS_ENCODER_SYMBOL_EGRESS_FIELDS,
  query_fields: REMOTE_ATLAS_ENCODER_QUERY_EGRESS_FIELDS,
});

/**
 * @typedef {Object} RemoteAtlasEncoderClientOptions
 * @property {string} [baseUrl]
 * @property {number} [timeoutMs]
 * @property {number} [maxRetries]
 * @property {number} [retryDelayMs]
 * @property {number} [maxResponseBytes]
 * @property {typeof fetch} [fetchImpl]
 * @property {string | null} [apiKey]
 */

export function normalizeRemoteAtlasEncodeRequest(request = {}) {
  const symbols = Array.isArray(request.symbols) ? request.symbols.map(buildRemoteAtlasSymbol) : null;
  const texts = Array.isArray(request.texts)
    ? request.texts.map((text) => String(text ?? ""))
    : null;
  const kind = String(request.kind || (symbols ? "symbols" : "queries")).trim().toLowerCase();
  if (kind === "symbols" && (!symbols || symbols.length === 0)) {
    throw new TypeError("remote ATLAS encode symbols request requires symbols");
  }
  if (kind === "queries" && (!texts || texts.length === 0)) {
    throw new TypeError("remote ATLAS encode queries request requires texts");
  }
  return compactObject({
    request_id: request.request_id || request.requestId || undefined,
    batch_id: request.batch_id || request.batchId || undefined,
    repo_fingerprint: request.repo_fingerprint || request.repoFingerprint || undefined,
    kind,
    model_hint: request.model_hint || request.modelHint || undefined,
    symbols: kind === "symbols" ? symbols : undefined,
    texts: kind === "queries" ? texts : undefined,
  });
}

export function buildRemoteAtlasSymbol(symbol = {}) {
  const out = {};
  for (const field of REMOTE_ATLAS_ENCODER_SYMBOL_EGRESS_FIELDS) {
    out[field] = field === "local_id"
      ? (Number.isInteger(symbol.local_id) ? symbol.local_id : undefined)
      : symbol[field];
  }
  return compactObject(out);
}

function compactObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined && value !== null),
  );
}
