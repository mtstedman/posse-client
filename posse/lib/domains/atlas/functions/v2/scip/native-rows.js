// @ts-check
//
// Native SCIP -> ATLAS row conversion. JS remains responsible for ledger
// writes and external-symbol persistence; Rust owns the symbol/edge derivation.

import { createHash } from "node:crypto";
import { runAtlasNativeMethodAsync } from "../native/invoke.js";

/**
 * @param {{ index: Record<string, any>, timeoutMs?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function scipIndexToRowsNative({ index, timeoutMs = 120_000 } = {}) {
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

export async function scipIndexToRowsBatchedNative({ index, timeoutMs = 120_000, batchSize = 32 } = {}) {
  if (!index || typeof index !== "object") throw new TypeError("scipIndexToRowsBatchedNative: index is required");
  const nativeIndex = scipIndexForNative(index);
  const documents = Array.isArray(nativeIndex.documents) ? nativeIndex.documents : [];
  const size = Math.max(1, Math.min(4096, Math.trunc(Number(batchSize) || 32)));
  const configuredFirstSize = Math.trunc(Number(process.env.POSSE_ATLAS_SCIP_FIRST_BATCH_SIZE) || 0);
  const firstSize = configuredFirstSize > 0
    ? Math.max(1, Math.min(size, configuredFirstSize))
    : size;
  if (documents.length <= firstSize) return scipIndexToRowsNative({ index, timeoutMs });
  const batches = scipDocumentBatches(documents, size, firstSize);
  const filesetHash = scipFilesetHash(documents);
  const opened = /** @type {Record<string, any>} */ (await runAtlasNativeMethodAsync("scip-session-open", {
    versionId: `intake-${process.pid}-${Date.now()}`,
    filesetHash,
    language: String(documents[0]?.language || "unknown"),
    batches: batches.map((batch, ordinal) => ({
      ordinal,
      paths: batch.map((document) => String(document?.relative_path || document?.relativePath || "")),
    })),
    policyVersion: "scip-batch-intake-v1",
    index: nativeIndex,
  }, { timeoutMs, idempotent: false }));
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
      ? Buffer.from(bytes)
      : Buffer.from(String(document?.text || ""), "utf8");
    return [repoPath, createHash("sha256").update(content).digest("hex")];
  }).sort((left, right) => Buffer.compare(Buffer.from(left[0]), Buffer.from(right[0])));
  return createHash("sha256").update(pairs.map(([repoPath, hash]) => `${repoPath}\0${hash}`).join("\n")).digest("hex");
}

export function __testScipIndexForNative(index) {
  return scipIndexForNative(index);
}

export function __testScipBatchSizes({ documentCount, batchSize, firstBatchSize }) {
  const count = Math.max(0, Math.trunc(Number(documentCount) || 0));
  const size = Math.max(1, Math.min(4096, Math.trunc(Number(batchSize) || 32)));
  const first = Math.max(1, Math.min(size, Math.trunc(Number(firstBatchSize) || size)));
  return scipDocumentBatches(Array.from({ length: count }, (_, index) => index), size, first).map((batch) => batch.length);
}

function scipIndexForNative(index) {
  const documents = Array.isArray(index.documents) ? index.documents.map((document) => {
    const doc = document && typeof document === "object" ? document : {};
    const { source_bytes, sourceBytes, ...rest } = doc;
    if (!rest.text && sourceByteLength(source_bytes ?? sourceBytes) === 0) {
      return { ...rest, source_bytes: [] };
    }
    return rest;
  }) : [];
  return {
    ...index,
    documents,
  };
}

function sourceByteLength(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object" && Array.isArray(value.data)) return value.data.length;
  return null;
}
