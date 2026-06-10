// @ts-check

import { createHash } from "node:crypto";
import { threadId, isMainThread } from "node:worker_threads";

import { appendPersistentTelemetry } from "../../../../../shared/telemetry/functions/persistent-log.js";

const STREAM = "atlas-embedding-forensics";
const MAX_SAMPLES = 5;

/**
 * @param {string} event
 * @param {Record<string, any>} [data]
 */
export function recordEmbeddingForensics(event, data = {}) {
  appendPersistentTelemetry(STREAM, {
    event,
    component: "atlas.embedding.forensics",
    thread_id: threadId,
    is_main_thread: isMainThread,
    memory: memorySnapshot(),
    ...data,
  });
}

/**
 * @param {unknown} err
 * @returns {Record<string, any>}
 */
export function errorForTelemetry(err) {
  const e = /** @type {any} */ (err);
  return {
    name: e?.name || "Error",
    message: e?.message || String(err || "unknown error"),
    code: e?.code ?? null,
    errno: e?.errno ?? null,
    syscall: e?.syscall ?? null,
    path: e?.path ?? null,
    stack: typeof e?.stack === "string" ? e.stack.slice(0, 8000) : null,
  };
}

/**
 * @param {unknown[]} values
 * @returns {Record<string, any>}
 */
export function summarizeTexts(values = []) {
  const texts = Array.isArray(values) ? values : [];
  const lengths = texts.map((text) => String(text ?? "").length);
  const count = lengths.length;
  const totalChars = lengths.reduce((sum, length) => sum + length, 0);
  return {
    count,
    total_chars: totalChars,
    min_chars: count > 0 ? Math.min(...lengths) : 0,
    max_chars: count > 0 ? Math.max(...lengths) : 0,
    avg_chars: count > 0 ? Math.round((totalChars / count) * 10) / 10 : 0,
    hash: stableHash(texts.map((text) => String(text ?? "").slice(0, 2000))),
  };
}

/**
 * @param {unknown[]} values
 * @returns {Record<string, any>}
 */
export function summarizeSymbols(values = []) {
  const symbols = Array.isArray(values) ? values : [];
  const localIds = symbols
    .map((symbol) => Number(/** @type {any} */ (symbol)?.local_id))
    .filter((value) => Number.isInteger(value));
  const langCounts = {};
  const paths = [];
  const hashes = [];
  for (const symbol of symbols) {
    const s = /** @type {any} */ (symbol);
    const lang = String(s?.lang || "").trim().toLowerCase() || "unknown";
    langCounts[lang] = (langCounts[lang] || 0) + 1;
    if (paths.length < MAX_SAMPLES && s?.repo_rel_path) paths.push(String(s.repo_rel_path));
    if (hashes.length < MAX_SAMPLES && s?.content_hash) hashes.push(String(s.content_hash).slice(0, 16));
  }
  return {
    count: symbols.length,
    local_id_min: localIds.length > 0 ? Math.min(...localIds) : null,
    local_id_max: localIds.length > 0 ? Math.max(...localIds) : null,
    first: symbolIdentity(symbols[0]),
    last: symbolIdentity(symbols[symbols.length - 1]),
    path_samples: paths,
    content_hash_samples: hashes,
    lang_counts: langCounts,
    hash: stableHash(symbols.map(symbolIdentity)),
  };
}

/**
 * @param {unknown[]} values
 * @returns {Record<string, any>}
 */
export function summarizeRows(values = []) {
  const rows = Array.isArray(values) ? values : [];
  const localIds = rows
    .map((row) => Number(/** @type {any} */ (row)?.local_id))
    .filter((value) => Number.isInteger(value));
  const vectorLengths = rows
    .map((row) => Number(/** @type {any} */ (row)?.vector?.length))
    .filter((value) => Number.isFinite(value));
  return {
    count: rows.length,
    local_id_min: localIds.length > 0 ? Math.min(...localIds) : null,
    local_id_max: localIds.length > 0 ? Math.max(...localIds) : null,
    vector_dim_min: vectorLengths.length > 0 ? Math.min(...vectorLengths) : null,
    vector_dim_max: vectorLengths.length > 0 ? Math.max(...vectorLengths) : null,
    first: rowIdentity(rows[0]),
    last: rowIdentity(rows[rows.length - 1]),
    hash: stableHash(rows.map(rowIdentity)),
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function symbolIdentity(value) {
  const symbol = /** @type {any} */ (value);
  if (!symbol || typeof symbol !== "object") return null;
  return {
    path: symbol.repo_rel_path || null,
    local_id: Number.isInteger(symbol.local_id) ? symbol.local_id : null,
    content_hash: typeof symbol.content_hash === "string" ? symbol.content_hash.slice(0, 16) : null,
    lang: symbol.lang || null,
    kind: symbol.kind || null,
    name: symbol.name || null,
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function rowIdentity(value) {
  const row = /** @type {any} */ (value);
  if (!row || typeof row !== "object") return null;
  return {
    local_id: Number.isInteger(row.local_id) ? row.local_id : null,
    content_hash: typeof row.content_hash === "string" ? row.content_hash.slice(0, 16) : null,
    vector_dim: Number.isInteger(row?.vector?.length) ? row.vector.length : null,
  };
}

function memorySnapshot() {
  try {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss,
      heap_used: usage.heapUsed,
      heap_total: usage.heapTotal,
      external: usage.external,
      array_buffers: usage.arrayBuffers,
    };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 */
function stableHash(value) {
  try {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}
