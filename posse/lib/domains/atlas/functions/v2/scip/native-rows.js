// @ts-check
//
// Native SCIP -> ATLAS row conversion. JS remains responsible for ledger
// writes and external-symbol persistence; Rust owns the symbol/edge derivation.

import { createHash } from "node:crypto";
import { runAtlasNativeMethodAsync } from "../native/invoke.js";

const SCIP_ROLE_DEFINITION = 0x1;
const SCIP_ROLE_IMPORT = 0x2;

const SCIP_FIRST_FRAME_BATCH_SIZE = 8;
const SCIP_NATIVE_REQUEST_TIMEOUT_MS = 120_000;
const SCIP_SESSION_OPEN_QUEUE_HEADROOM_MS = 60_000;
const SCIP_SESSION_OPEN_DOCUMENT_MS = 50;
const SCIP_SESSION_OPEN_OCCURRENCE_MS = 1;
const SCIP_SESSION_OPEN_MAX_TIMEOUT_MS = 10 * 60_000;

/**
 * @param {{ index?: Record<string, any>, timeoutMs?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function scipIndexToRowsNative({ index, timeoutMs = SCIP_NATIVE_REQUEST_TIMEOUT_MS } = {}) {
  if (!index || typeof index !== "object") {
    throw new TypeError("scipIndexToRowsNative: index is required");
  }
  return /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("scip-rows", {
    index: scipIndexForNative(index),
    assignExternalIds: true,
  }, {
    timeoutMs,
  }));
}

/**
 * @param {{ index?: Record<string, any>, timeoutMs?: number, batchSize?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function scipIndexToRowsBatchedNative({ index, timeoutMs = SCIP_NATIVE_REQUEST_TIMEOUT_MS, batchSize = 32 } = {}) {
  if (!index || typeof index !== "object") throw new TypeError("scipIndexToRowsBatchedNative: index is required");
  const nativeIndex = scipIndexForNative(index);
  const documents = Array.isArray(nativeIndex.documents) ? nativeIndex.documents : [];
  const size = Math.max(1, Math.min(4096, Math.trunc(Number(batchSize) || 32)));
  const firstSize = Math.min(size, SCIP_FIRST_FRAME_BATCH_SIZE);
  if (documents.length <= firstSize) return scipIndexToRowsNative({ index, timeoutMs });
  const batches = scipDocumentBatches(documents, size, firstSize);
  const filesetHash = scipFilesetHash(documents);
  // Session open performs the whole-index definition prepass and shares the
  // persistent native lane with concurrent Tree-sitter ledger writes. A fixed
  // two-minute request deadline can therefore expire before a large index has
  // reached the head of that lane. Keep individual batch deadlines bounded,
  // but scale the one whole-index request by its actual document/occurrence
  // workload and include explicit queue headroom.
  const sessionOpenTimeoutMs = scipSessionOpenTimeoutMs(nativeIndex, timeoutMs);
  const opened = /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("scip-session-open", {
    versionId: `intake-${process.pid}-${Date.now()}`,
    filesetHash,
    language: String(documents[0]?.language || "unknown"),
    batches: batches.map((batch, ordinal) => ({
      ordinal,
      paths: batch.map((document) => String(document?.relative_path || document?.relativePath || "")),
    })),
    policyVersion: "scip-batch-intake-v1",
    // Session open only uses the index to build its cross-batch definition
    // binding map. Sending every reference occurrence, range, documentation,
    // and external symbol can push a legitimate repository over the native
    // worker's 64 MiB JSONL request limit (Symfony was 68.8 MiB; ESLint was
    // larger still). Preserve exactly the fields consumed by the native
    // definition prepass while keeping the frame bounded for real corpora.
    index: scipDefinitionPrepassIndex(nativeIndex),
  }, { timeoutMs: sessionOpenTimeoutMs, idempotent: false }));
  const sessionId = String(opened.sessionId || "");
  const combined = { fileset_hash: filesetHash, occurrence_count: 0, documents: [], external_ids: {}, external_monikers: {} };
  try {
    for (let ordinal = 0; ordinal < batches.length; ordinal++) {
      const ingested = /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("scip-batch-ingest", {
        sessionId,
        batchOrdinal: ordinal,
        index: { ...nativeIndex, documents: batches[ordinal] },
        assignExternalIds: true,
      }, { timeoutMs, idempotent: false }));
      const rows = ingested.rows || {};
      combined.documents.push(...(rows.documents || []));
      combined.occurrence_count += Number(rows.occurrence_count ?? rows.occurrenceCount ?? 0);
      combined.external_ids = rows.external_ids || rows.externalIds || combined.external_ids;
      Object.assign(combined.external_monikers, rows.external_monikers || rows.externalMonikers || {});
    }
    await runAtlasNativeMethodAsync("scip-session-finalize", { sessionId, filesetHash }, { timeoutMs, idempotent: false });
    if (process.env.POSSE_INTAKE_BENCH_TRACE === "1") console.error(JSON.stringify({
      intakeBenchmarkRoute: "scip-session-open/scip-batch-ingest/scip-session-finalize",
      intakeMode: "batched",
      documents: documents.length,
      batches: batches.length,
      batchSize: size,
      firstBatchSize: firstSize,
    }));
    return combined;
  } catch (error) {
    try { await runAtlasNativeMethodAsync("scip-session-abort", { sessionId }, { timeoutMs: 10_000, idempotent: false }); } catch { /* original intake error wins */ }
    throw error;
  }
}

function scipDocumentBatches(documents, batchSize, firstBatchSize) {
  const batches = [documents.slice(0, firstBatchSize)];
  for (let start = firstBatchSize; start < documents.length; start += batchSize) {
    batches.push(documents.slice(start, start + batchSize));
  }
  return batches;
}

function scipFilesetHash(documents) {
  const pairs = documents.map((document) => {
    const repoPath = String(document?.relative_path || document?.relativePath || "");
    const bytes = document?.source_bytes ?? document?.sourceBytes;
    const content = bytes && (Array.isArray(bytes) || ArrayBuffer.isView(bytes))
      ? Buffer.from(/** @type {any} */ (bytes))
      : Buffer.from(String(document?.text || ""), "utf8");
    return [repoPath, createHash("sha256").update(content).digest("hex")];
  }).sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])));
  return createHash("sha256").update(pairs.map(([repoPath, hash]) => `${repoPath}\0${hash}`).join("\n")).digest("hex");
}

export function __testScipIndexForNative(index) {
  return scipIndexForNative(index);
}

export function __testScipDefinitionPrepassIndex(index) {
  return scipDefinitionPrepassIndex(scipIndexForNative(index));
}

export function __testScipBatchSizes({ documentCount, batchSize }) {
  const count = Math.max(0, Math.trunc(Number(documentCount) || 0));
  const size = Math.max(1, Math.min(4096, Math.trunc(Number(batchSize) || 32)));
  const first = Math.min(size, SCIP_FIRST_FRAME_BATCH_SIZE);
  return scipDocumentBatches(Array.from({ length: count }, (_, index) => index), size, first).map((batch) => batch.length);
}

/** @param {{ documentCount?: number, occurrenceCount?: number, timeoutMs?: number }} [input] */
export function __testScipSessionOpenTimeoutMs(input = {}) {
  const { documentCount, occurrenceCount, timeoutMs } = input;
  const count = Math.max(0, Math.trunc(Number(documentCount) || 0));
  const occurrences = Math.max(0, Math.trunc(Number(occurrenceCount) || 0));
  return scipSessionOpenTimeoutForCounts(count, occurrences, timeoutMs);
}

function scipSessionOpenTimeoutMs(index, timeoutMs) {
  const documents = Array.isArray(index?.documents) ? index.documents : [];
  const occurrenceCount = documents.reduce((total, document) => (
    total + (Array.isArray(document?.occurrences) ? document.occurrences.length : 0)
  ), 0);
  return scipSessionOpenTimeoutForCounts(documents.length, occurrenceCount, timeoutMs);
}

function scipSessionOpenTimeoutForCounts(documentCount, occurrenceCount, timeoutMs) {
  const requested = Number(timeoutMs);
  const base = Number.isFinite(requested) && requested > 0
    ? Math.trunc(requested)
    : SCIP_NATIVE_REQUEST_TIMEOUT_MS;
  const estimated = base
    + SCIP_SESSION_OPEN_QUEUE_HEADROOM_MS
    + (documentCount * SCIP_SESSION_OPEN_DOCUMENT_MS)
    + (occurrenceCount * SCIP_SESSION_OPEN_OCCURRENCE_MS);
  return Math.max(base, Math.min(Math.max(base, SCIP_SESSION_OPEN_MAX_TIMEOUT_MS), estimated));
}

function scipIndexForNative(index) {
  const documents = Array.isArray(index.documents) ? index.documents.map((document) => {
    const doc = document && typeof document === "object" ? document : {};
    const { source_bytes, sourceBytes, ...rest } = doc;
    const bytes = sourceBytesBuffer(source_bytes ?? sourceBytes);
    if (!rest.text && bytes?.length === 0) {
      return { ...rest, source_bytes: [] };
    }
    if (bytes && !bytes.equals(Buffer.from(String(rest.text || ""), "utf8"))) {
      return { ...rest, source_bytes: [...bytes] };
    }
    return rest;
  }) : [];
  return {
    ...index,
    documents,
  };
}

function scipDefinitionPrepassIndex(index) {
  const documents = Array.isArray(index?.documents) ? index.documents : [];
  return {
    metadata: index?.metadata || {},
    documents: documents.map((document) => {
      const doc = document && typeof document === "object" ? document : {};
      const definitions = Array.isArray(doc.occurrences)
        ? doc.occurrences.filter((occurrence) => {
            const roles = Number(occurrence?.symbol_roles ?? occurrence?.symbolRoles ?? 0);
            return (roles & SCIP_ROLE_DEFINITION) !== 0 && (roles & SCIP_ROLE_IMPORT) === 0;
          })
        : [];
      const definitionSymbols = new Set(definitions.map((occurrence) => String(occurrence?.symbol || "")));
      const symbols = Array.isArray(doc.symbols)
        ? doc.symbols
          .filter((symbol) => definitionSymbols.has(String(symbol?.symbol || "")))
          .map((symbol) => ({
            symbol: String(symbol?.symbol || ""),
            display_name: String(symbol?.display_name ?? symbol?.displayName ?? ""),
          }))
        : [];
      return {
        relative_path: String(doc.relative_path ?? doc.relativePath ?? ""),
        // Range and syntax fields do not participate in definition binding.
        // Normalizing the retained role to "definition" also removes
        // producer-specific auxiliary bits without changing prepass meaning.
        occurrences: definitions.map((occurrence) => ({
          symbol: String(occurrence?.symbol || ""),
          symbol_roles: SCIP_ROLE_DEFINITION,
        })),
        symbols,
        text: String(doc.text || ""),
        position_encoding: Number(doc.position_encoding ?? doc.positionEncoding ?? 0) || 0,
        ...(doc.source_bytes != null ? { source_bytes: doc.source_bytes } : {}),
        ...(doc.atlas_skip_reason ? { atlas_skip_reason: String(doc.atlas_skip_reason) } : {}),
        ...(doc.atlas_skip_message ? { atlas_skip_message: String(doc.atlas_skip_message) } : {}),
      };
    }),
    external_symbols: [],
  };
}

function sourceBytesBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Buffer.from(value);
  if (value && typeof value === "object" && Array.isArray(value.data)) {
    return Buffer.from(value.data);
  }
  return null;
}
