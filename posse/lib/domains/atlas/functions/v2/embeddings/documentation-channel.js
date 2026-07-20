// @ts-check

import { sha256Hex } from "../hash.js";

/** @typedef {import("../contracts/embeddings.js").EmbeddingHit} EmbeddingHit */
/** @typedef {import("../contracts/embeddings.js").EmbeddingSymbolInput} EmbeddingSymbolInput */

export const DOCUMENTATION_TEXT_SHAPE_VERSION = 1;
const DOCUMENTATION_KEY_ROOT = "atlas-doc-v";
export const DOCUMENTATION_KEY_PREFIX = `${DOCUMENTATION_KEY_ROOT}${DOCUMENTATION_TEXT_SHAPE_VERSION}:`;

const DOCUMENTATION_TEXT_CAP = 2_000;
const DOCUMENTATION_SUMMARY_CAP = 240;
const SIGNATURE_TEXT_CAP = 200;
const DOCUMENTATION_SCORE_WEIGHT = 0.9;
const CHANNEL_AGREEMENT_BONUS = 0.025;

/**
 * Normalize parser-produced documentation without attempting language-specific
 * semantic interpretation. SCIP commonly supplies already-clean Markdown,
 * while fallback parsers may retain JSDoc comment delimiters and leading `*`s.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDocumentation(value) {
  if (value == null) return "";
  let text = String(value).replace(/\r\n?/g, "\n").trim();
  if (text.startsWith("/**") && text.endsWith("*/")) {
    text = text.slice(3, -2);
  }
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Deterministic display shorthand. Embeddings are retrieval representations,
 * not a generative summary surface, so cards use the first prose sentence (or
 * first prose block) and retain the source location as the path to full docs.
 *
 * @param {unknown} value
 * @param {number} [cap]
 * @returns {string | null}
 */
export function compactDocumentationSummary(value, cap = DOCUMENTATION_SUMMARY_CAP) {
  const normalized = normalizeDocumentation(value);
  if (!normalized) return null;
  const proseLines = [];
  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (/^@[A-Za-z][\w-]*/.test(trimmed)) break;
    if (trimmed) proseLines.push(trimmed);
    else if (proseLines.length > 0) break;
  }
  const prose = collapseWhitespace(proseLines.join(" ")) || collapseWhitespace(normalized);
  const sentence = firstSentence(prose);
  return boundedAtWord(sentence || prose, cap);
}

/**
 * Documentation-only embedding input. Identity fields act as anchors, but the
 * code body is deliberately absent so documentation can be ranked and evolved
 * independently from the canonical code channel.
 *
 * @param {EmbeddingSymbolInput} symbol
 * @returns {string}
 */
export function buildDocumentationText(symbol) {
  if (!symbol || typeof symbol.name !== "string") {
    throw new TypeError("buildDocumentationText: symbol with .name is required");
  }
  const documentation = boundedAtWord(
    collapseWhitespace(normalizeDocumentation(symbol.doc)),
    DOCUMENTATION_TEXT_CAP,
    false,
  );
  if (!documentation) return "";
  return [
    symbol.kind,
    symbol.lang,
    symbol.qualified_name || symbol.name,
    boundedAtWord(collapseWhitespace(symbol.signature_text), SIGNATURE_TEXT_CAP, false),
    `documentation: ${documentation}`,
  ].filter((part) => typeof part === "string" && part.length > 0).join(" § ");
}

/**
 * Store documentation in the same ANN/keys sidecar under an opaque, versioned
 * namespace. The source content hash remains decodable for view hydration; the
 * final component fingerprints the exact documentation embedding input.
 *
 * @param {EmbeddingSymbolInput & { content_hash?: string, local_id?: number }} symbol
 * @returns {{ content_hash: string, local_id: number, fingerprint: string, text: string } | null}
 */
export function documentationEmbeddingKey(symbol) {
  const sourceHash = String(symbol?.content_hash || "").trim();
  if (!sourceHash || !Number.isInteger(symbol?.local_id)) return null;
  const text = buildDocumentationText(symbol);
  if (!text) return null;
  const fingerprint = sha256Hex(text);
  return {
    content_hash: `${DOCUMENTATION_KEY_PREFIX}${sourceHash}:${fingerprint}`,
    local_id: /** @type {number} */ (symbol.local_id),
    fingerprint,
    text,
  };
}

/**
 * All vector keys required for one symbol. Code retains the canonical
 * `(content_hash, local_id)` key; documentation is optional and separately
 * fingerprinted.
 *
 * @param {EmbeddingSymbolInput & { content_hash?: string, local_id?: number }} symbol
 * @returns {Array<{ content_hash: string, local_id: number, channel: "code" | "documentation" }>}
 */
export function embeddingKeysForSymbol(symbol) {
  const sourceHash = String(symbol?.content_hash || "").trim();
  if (!sourceHash || !Number.isInteger(symbol?.local_id)) return [];
  /** @type {Array<{ content_hash: string, local_id: number, channel: "code" | "documentation" }>} */
  const keys = [{
    content_hash: sourceHash,
    local_id: /** @type {number} */ (symbol.local_id),
    channel: "code",
  }];
  const documentation = documentationEmbeddingKey(symbol);
  if (documentation) {
    keys.push({
      content_hash: documentation.content_hash,
      local_id: documentation.local_id,
      channel: "documentation",
    });
  }
  return keys;
}

/**
 * @param {string} contentHash
 * @returns {{ channel: "code" | "documentation", source_content_hash: string, fingerprint: string | null, version: number | null }}
 */
export function decodeEmbeddingContentHash(contentHash) {
  const value = String(contentHash || "");
  const prefix = value.match(/^atlas-doc-v(\d+):/);
  if (!prefix) {
    return { channel: "code", source_content_hash: value, fingerprint: null, version: null };
  }
  const namespaced = value.slice(prefix[0].length);
  const separator = namespaced.lastIndexOf(":");
  if (separator <= 0 || separator === namespaced.length - 1) {
    return { channel: "code", source_content_hash: value, fingerprint: null, version: null };
  }
  return {
    channel: "documentation",
    source_content_hash: namespaced.slice(0, separator),
    fingerprint: namespaced.slice(separator + 1),
    version: Number(prefix[1]),
  };
}

/**
 * Deduplicate code/documentation ANN rows by source symbol and apply a modest
 * discount to documentation-only evidence. Agreement may break close ties but
 * cannot add more than 2.5 percentage points to a result.
 *
 * @param {EmbeddingHit[]} hits
 * @param {{ k?: number, minScore?: number }} [options]
 * @returns {Array<EmbeddingHit & {
 *   channels: Array<"code" | "documentation">,
 *   channel_scores: { code: number | null, documentation: number | null },
 * }>}
 */
export function fuseEmbeddingChannelHits(hits, options = {}) {
  const limit = Math.max(1, Math.min(Number.isInteger(options.k) ? Number(options.k) : 20, 1_000));
  const minScore = typeof options.minScore === "number" ? options.minScore : 0;
  const grouped = new Map();
  for (const hit of Array.isArray(hits) ? hits : []) {
    const decoded = decodeEmbeddingContentHash(hit?.content_hash);
    const localId = Number(hit?.local_id);
    const score = Number(hit?.score);
    const distance = Number(hit?.distance);
    if (
      !decoded.source_content_hash
      || !Number.isInteger(localId)
      || !Number.isFinite(score)
      || (decoded.channel === "documentation" && decoded.version !== DOCUMENTATION_TEXT_SHAPE_VERSION)
    ) continue;
    const key = `${decoded.source_content_hash}\0${localId}`;
    const group = grouped.get(key) || {
      content_hash: decoded.source_content_hash,
      local_id: localId,
      code: null,
      documentation: null,
      ordinal: grouped.size,
    };
    const current = group[decoded.channel];
    if (!current || score > current.score) {
      group[decoded.channel] = { score, distance };
    }
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group) => {
      const codeScore = group.code?.score ?? null;
      const documentationScore = group.documentation?.score ?? null;
      const weightedDocumentation = documentationScore == null
        ? null
        : documentationScore * DOCUMENTATION_SCORE_WEIGHT;
      let score = Math.max(codeScore ?? 0, weightedDocumentation ?? 0);
      if (codeScore != null && documentationScore != null) {
        score = Math.min(1, score + CHANNEL_AGREEMENT_BONUS * Math.min(codeScore, documentationScore));
      }
      return {
        content_hash: group.content_hash,
        local_id: group.local_id,
        score,
        distance: Math.max(0, 1 - score),
        channels: [
          ...(codeScore == null ? [] : [/** @type {const} */ ("code")]),
          ...(documentationScore == null ? [] : [/** @type {const} */ ("documentation")]),
        ],
        channel_scores: { code: codeScore, documentation: documentationScore },
        ordinal: group.ordinal,
      };
    })
    .filter((hit) => hit.score >= minScore)
    .sort((left, right) => right.score - left.score || left.ordinal - right.ordinal)
    .slice(0, limit)
    .map(({ ordinal: _ordinal, ...hit }) => hit);
}

/** @param {unknown} value */
function collapseWhitespace(value) {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

/** @param {string} value */
function firstSentence(value) {
  const match = String(value || "").match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1] : value;
}

/**
 * @param {string} value
 * @param {number} cap
 * @param {boolean} [ellipsis]
 */
function boundedAtWord(value, cap, ellipsis = true) {
  const text = String(value || "");
  const limit = Math.max(1, Number.isFinite(Number(cap)) ? Math.floor(Number(cap)) : text.length);
  if (text.length <= limit) return text;
  const suffix = ellipsis && limit > 1 ? "…" : "";
  const slice = text.slice(0, Math.max(1, limit - suffix.length));
  const boundary = slice.lastIndexOf(" ");
  const bounded = boundary >= Math.floor(slice.length * 0.6) ? slice.slice(0, boundary) : slice;
  return `${bounded.trimEnd()}${suffix}`;
}
