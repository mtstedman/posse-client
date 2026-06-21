// @ts-check
//
// SCIP ingester. Reads a `.scip` file from disk (or accepts an in-memory
// buffer), decodes it, derives ATLAS SymbolRow/EdgeRow per document, and
// pushes them through Ledger.ingestBlob alongside a `scip_indexes`
// bookkeeping row.
//
// Idempotent: re-ingesting the same .scip (matching scheme, indexer_version,
// fileset_hash, config_hash, deps_hash) short-circuits and returns
// `{ skipped: true }`. The caller decides whether that's worth emitting.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeScipIndex } from "./decode.js";
import { scipIndexToRowsNative } from "./native-rows.js";
import { ATLAS_SCIP_ROWS_SPEC_VERSION, normalizeLangFromScip } from "./to-rows.js";
import { sha256Hex } from "../hash.js";
import { normalizeRepoPath, repoRelativeFromAbsolute } from "../paths.js";
import { languageForPath } from "../parse/language-buckets.js";
import { inspectSampleForMinified, isLikelyMinifiedPath, MINIFIED_SAMPLE_BYTES } from "../parser/index-filters.js";
import { runSqliteWrite } from "../../../../../shared/concurrency/functions/sqlite-gate.js";

/** @typedef {import("../../../classes/v2/Ledger.js").Ledger} Ledger */

/**
 * @typedef {Object} ScipIngestResult
 * @property {boolean} skipped              True when the bookkeeping row already existed.
 * @property {number} documents_ingested
 * @property {number} documents_failed
 * @property {number} documents_skipped
 * @property {number} [documents_missing_text]   Docs whose source no longer exists on disk (stale-.scip drift).
 * @property {number} [documents_range_clamped]  Docs whose source changed under the index (drift).
 * @property {boolean} [stale_scip]              True when missing_text drift was observed; restage, don't re-ingest.
 * @property {number} blobs_reused
 * @property {number} external_symbols
 * @property {string[]} covered_content_hashes  Hashes of every blob SCIP touched.
 * @property {number} ledger_entries_appended
 * @property {string} scheme
 * @property {string} fileset_hash
 * @property {number | null} scip_index_id
 * @property {"complete" | "partial"} status
 */

/**
 * @param {{
 *   ledger: Ledger,
 *   scipPath?: string,
 *   bytes?: Buffer | Uint8Array,
 *   repoRoot: string,
 *   configHash?: string,
 *   depsHash?: string,
 *   producedAt?: string | null,
 *   onEvent?: (event: { kind: string, [k: string]: any }) => void,
 *   force?: boolean,
 *   forceIfMissing?: boolean,
 *   branch?: string | null,
 *   appendLedgerEntries?: boolean,
 *   layerOnly?: boolean,
 *   rowsSpecVersion?: string,
 * }} args
 * @returns {Promise<ScipIngestResult>}
 */
/**
 * Combine the caller's config hash with the SCIP→rows spec version. A version
 * bump changes this value, so `findScipIndexId` no longer matches the prior
 * record (forcing a re-ingest) and `ingestBlobLayer` writes a fresh layer that
 * supersedes the stale one.
 * @param {string | undefined} configHash
 * @param {string} rowsSpecVersion
 * @returns {string}
 */
function scipRowsConfigHash(configHash, rowsSpecVersion) {
  const base = String(configHash || "");
  const tag = `scip-rows@${String(rowsSpecVersion || "")}`;
  return base ? `${base} ${tag}` : tag;
}

export async function ingestScipFile({
  ledger,
  scipPath,
  bytes,
  repoRoot,
  configHash,
  depsHash,
  producedAt = null,
  onEvent,
  force = false,
  forceIfMissing = false,
  branch = null,
  appendLedgerEntries = true,
  layerOnly = false,
  rowsSpecVersion = ATLAS_SCIP_ROWS_SPEC_VERSION,
}) {
  if (!ledger) throw new TypeError("ingestScipFile: ledger is required");
  if (!repoRoot) throw new TypeError("ingestScipFile: repoRoot is required");
  // Fold the SCIP→rows spec version into config_hash so a transformation change
  // invalidates already-ingested indexes/layers and forces a re-ingest. config_hash
  // is otherwise unused by callers, so it is a safe carrier.
  const effectiveConfigHash = scipRowsConfigHash(configHash, rowsSpecVersion);

  let buf = bytes;
  let effectiveProducedAt = producedAt;
  if (!buf) {
    if (!scipPath) throw new TypeError("ingestScipFile: scipPath or bytes is required");
    buf = await fs.promises.readFile(scipPath);
    if (effectiveProducedAt == null) {
      try { effectiveProducedAt = (await fs.promises.stat(scipPath)).mtime.toISOString(); }
      catch { effectiveProducedAt = null; }
    }
  }
  let index;
  try {
    index = decodeScipIndex(buf);
  } catch (err) {
    return handleScipIndexDecodeFailure({ buf, err, onEvent, scipPath });
  }
  const scheme = inferSchemeFromIndex(index);
  if (!scheme) {
    throw new RangeError("ingestScipFile: Metadata.ToolInfo.name is required when no SCIP symbol scheme can be inferred");
  }
  // Derive a single canonical `language` tag for indexer diagnostics.
  // SCIP `scheme` is e.g. "scip-python", "scip-typescript", "scip-php" — the
  // suffix maps 1:1 to our atlas_scip_languages catalog. Display routing uses
  // source-language buckets below so scip-typescript can still distinguish JS
  // files from TS files.
  const language = String(scheme || "").replace(/^scip-/, "").toLowerCase() || null;
  await prepareAndMutateDocumentText(index, repoRoot);
  const nativeRows = await scipIndexToRowsNative({ index });
  const rowDocuments = normalizeNativeRowDocuments(nativeRows?.documents);
  const totalDocuments = rowDocuments.length;
  let sourceLanguages = collectSourceLanguages(rowDocuments);
  let sourceLanguageTotals = collectSourceLanguageCounts(rowDocuments);
  const sourceLanguageCurrent = zeroCountsFromTotals(sourceLanguageTotals);
  emit(onEvent, {
    kind: "atlas.scip.ingest.started",
    scheme,
    language,
    source_languages: sourceLanguages,
    source_language_current: { ...sourceLanguageCurrent },
    source_language_total: { ...sourceLanguageTotals },
    documents: totalDocuments,
    current: 0,
    total: totalDocuments,
    percent: 0,
  });
  if (!index.metadata.tool_info.name) {
    emit(onEvent, {
      kind: "atlas.scip.ingest.warning",
      scheme,
      language,
      reason: "missing_tool_name",
      message: `SCIP Metadata.ToolInfo.name is absent; using inferred scheme '${scheme}'`,
    });
  }
  if (!index.metadata.tool_info.version) {
    emit(onEvent, {
      kind: "atlas.scip.ingest.warning",
      scheme,
      language,
      reason: "missing_tool_version",
      message: "SCIP Metadata.ToolInfo.version is absent; using 'unknown'",
    });
  }
  const filesetHash = String(nativeRows?.fileset_hash || nativeRows?.filesetHash || "");
  const indexerVersion = index.metadata.tool_info.version || "unknown";
  const toolName = index.metadata.tool_info.name || scheme;

  // Already ingested? recordScipIndex returns null when the bookkeeping
  // row's UNIQUE key matched — short-circuit the row work entirely.
  const langs = collectLangs(rowDocuments);
  resetCounts(sourceLanguageCurrent, sourceLanguageTotals);

  const indexRecord = {
    scheme,
    tool_name: toolName,
    indexer_version: indexerVersion,
    indexer_arguments: index.metadata.tool_info.arguments,
    project_root: index.metadata.project_root || repoRoot,
    langs,
    fileset_hash: filesetHash,
    config_hash: effectiveConfigHash,
    deps_hash: depsHash || "",
    document_count: totalDocuments,
    occurrence_count: nativeRowsNumber(nativeRows, "occurrence_count", "occurrenceCount"),
    external_symbol_count: index.external_symbols.length,
    produced_at: effectiveProducedAt,
  };

  const existingIndexId = typeof ledger.findScipIndexId === "function"
    ? ledger.findScipIndexId({
        scheme,
        indexer_version: indexerVersion,
        fileset_hash: filesetHash,
        config_hash: effectiveConfigHash,
        deps_hash: depsHash || "",
      })
    : null;

  const effectiveForce = force === true && !(forceIfMissing === true && existingIndexId != null);

  if (existingIndexId != null && !effectiveForce) {
    emit(onEvent, {
      kind: "atlas.scip.ingest.skipped",
      scheme,
      language,
      source_languages: sourceLanguages,
      source_language_current: { ...sourceLanguageCurrent },
      source_language_total: { ...sourceLanguageTotals },
      fileset_hash: filesetHash,
    });
    return {
      skipped: true,
      documents_ingested: 0,
      documents_failed: 0,
      documents_skipped: 0,
      blobs_reused: 0,
      external_symbols: 0,
      covered_content_hashes: [],
      ledger_entries_appended: 0,
      scheme,
      fileset_hash: filesetHash,
      scip_index_id: existingIndexId,
      status: "complete",
    };
  }

  /** @type {string[]} */
  const coveredHashes = [];
  let documentsIngested = 0;
  let blobsReused = 0;
  let externalsBound = 0;
  let documentsFailed = 0;
  let documentsSkipped = 0;
  let ledgerEntriesAppended = 0;
  // Drift evidence: missing_text means the index references a file the tree
  // no longer has (moved/deleted since staging); range clamps mean the file
  // changed under the index. Either signals a stale .scip that needs a
  // restage, not a re-ingest.
  let documentsMissingText = 0;
  let documentsRangeClamped = 0;

  const appendBranch = appendLedgerEntries && branch ? String(branch) : "";
  let pathSnapshot = null;
  let pathSnapshotError = null;
  if (appendBranch) {
    try {
      pathSnapshot = ledger.pathSnapshotAt(appendBranch, ledger.headSeq(appendBranch));
    } catch (err) {
      pathSnapshotError = err;
      emit(onEvent, {
        kind: "atlas.scip.ingest.warning",
        scheme,
        language,
        source_languages: sourceLanguages,
        reason: "branch_snapshot_failed",
        message: `SCIP ingest could not read branch snapshot for '${appendBranch}': ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  } else if (appendLedgerEntries) {
    emit(onEvent, {
      kind: "atlas.scip.ingest.warning",
      scheme,
      language,
      source_languages: sourceLanguages,
      reason: "append_branch_missing",
      message: "SCIP ingest will not append ledger entries because no branch was provided",
    });
  }

  const writeResult = await runScipIngestWrite(ledger, () => {
    if (pathSnapshotError) {
      // A failed branch-snapshot read fails every document identically, so
      // fail the run once up front instead of burning the whole document
      // loop (one thrown error + one failed event per document) on every
      // re-warm while the failure persists.
      documentsFailed = totalDocuments;
      emit(onEvent, {
        kind: "atlas.scip.ingest.failed",
        scheme,
        language,
        source_languages: sourceLanguages,
        reason: "branch_snapshot_failed",
        message: `SCIP ingest cannot append to branch '${appendBranch}' because its snapshot could not be read: ` +
          `${pathSnapshotError instanceof Error ? pathSnapshotError.message : String(pathSnapshotError)}`,
      });
      const recordedId = ledger.recordScipIndex({
        ...indexRecord,
        documents_failed: documentsFailed,
        status: "partial",
        return_existing: effectiveForce,
      });
      return { status: "partial", recordedId };
    }
    const externalIdMap = bindNativeExternalMonikers(ledger, nativeRows, () => { externalsBound++; });

    // Throttle per-document progress to ~1% steps (min every 5 docs) so the
    // display can update a real % bar without flooding the event channel.
    const progressStep = Math.max(5, Math.floor(totalDocuments / 100) || 5);
    let documentsProcessed = 0;
    const advanceDocumentProgress = (document) => {
      documentsProcessed++;
      const docLang = sourceLanguageForDocument(document);
      if (docLang) {
        sourceLanguageCurrent[docLang] = (sourceLanguageCurrent[docLang] || 0) + 1;
      }
    };
    const emitDocumentProgress = () => {
      if (documentsProcessed === totalDocuments
          || documentsProcessed === 1
          || documentsProcessed % progressStep === 0) {
        emit(onEvent, {
          kind: "atlas.scip.ingest.progress",
          scheme,
          language,
          source_languages: sourceLanguages,
          source_language_current: { ...sourceLanguageCurrent },
          source_language_total: { ...sourceLanguageTotals },
          fileset_hash: filesetHash,
          current: documentsProcessed,
          total: totalDocuments,
          percent: totalDocuments > 0 ? (documentsProcessed / totalDocuments) * 100 : 0,
          documents_failed: documentsFailed,
          documents_skipped: documentsSkipped,
        });
      }
    };
    for (const document of rowDocuments) {
      const repoRelPath = document.repo_rel_path || "";
      try {
        if (!repoRelPath) {
          throw new RangeError(`SCIP document path is not canonical repo-relative: ${document.repo_rel_path || "(empty)"}`);
        }
        if (document.skip_reason === "minified_skip") {
          documentsSkipped++;
          advanceDocumentProgress(document);
          emitDocumentProgress();
          continue;
        }
        if (document.skip_reason) {
          throw new RangeError(document.skip_message || document.skip_reason);
        }
        if (!document.content_hash) {
          throw new RangeError("SCIP document has no text and could not be hydrated from disk");
        }
        if (document.range_clamp_count > 0) {
          documentsRangeClamped++;
          emit(onEvent, {
            kind: "atlas.scip.ingest.warning",
            scheme,
            language,
            source_languages: sourceLanguages,
            repo_rel_path: repoRelPath,
            reason: "range_clamped",
            message: `${document.range_clamp_count} SCIP occurrence range(s) exceeded the hydrated source bounds`,
          });
        }

        const byteSize = document.byte_size;
        const blobAlreadyPresent = ledger.hasBlob(document.content_hash);
        if (blobAlreadyPresent && effectiveForce) {
          // Reparse path: drop the prior (tree-sitter) ingest so the SCIP
          // rows take over for this blob.
          ledger.reingestBlobWithBackend({ content_hash: document.content_hash });
        }

        const parseResult = bindNativeParseResult(document, externalIdMap);

        if (layerOnly && typeof ledger.ingestBlobLayer === "function") {
          // Layer cutover: SCIP always writes its own layer (incl. new blobs),
          // never the flat tables. The view merge combines it with tree-sitter.
          ledger.ingestBlobLayer({
            content_hash: document.content_hash,
            lang: parseResult.lang,
            byte_size: byteSize,
            symbols: parseResult.symbols,
            edges: parseResult.edges,
            source: "scip",
            tool_version: indexerVersion,
            parser_spec_version: scheme,
            config_hash: effectiveConfigHash,
            deps_hash: depsHash || "",
            fileset_hash: filesetHash,
          });
          if (blobAlreadyPresent && !effectiveForce) blobsReused++;
          else documentsIngested++;
        } else if (blobAlreadyPresent && !effectiveForce) {
          if (typeof ledger.ingestBlobLayer === "function") {
            ledger.ingestBlobLayer({
              content_hash: document.content_hash,
              lang: parseResult.lang,
              byte_size: byteSize,
              symbols: parseResult.symbols,
              edges: parseResult.edges,
              source: "scip",
              tool_version: indexerVersion,
              parser_spec_version: scheme,
              config_hash: effectiveConfigHash,
              deps_hash: depsHash || "",
              fileset_hash: filesetHash,
            });
          }
          if (typeof ledger.mergeBlobParseRows === "function") {
            ledger.mergeBlobParseRows({
              content_hash: document.content_hash,
              lang: parseResult.lang,
              byte_size: byteSize,
              symbols: parseResult.symbols,
              edges: parseResult.edges,
            });
          }
          blobsReused++;
        } else {
          ledger.ingestBlob({
            content_hash: document.content_hash,
            lang: parseResult.lang,
            byte_size: byteSize,
            symbols: parseResult.symbols,
            edges: parseResult.edges,
          });
          documentsIngested++;
        }
        coveredHashes.push(document.content_hash);
        ledgerEntriesAppended += appendDocumentDelta({
          ledger,
          branch: appendBranch,
          snapshot: pathSnapshot,
          repo_rel_path: repoRelPath,
          content_hash: document.content_hash,
        });
      } catch (err) {
        documentsFailed++;
        const failReason = document.skip_reason || (!repoRelPath ? "path_not_canonical" : "parse_error");
        if (failReason === "missing_text") documentsMissingText++;
        emit(onEvent, {
          kind: "atlas.scip.ingest.failed",
          scheme,
          language,
          source_languages: sourceLanguages,
          repo_rel_path: repoRelPath,
          reason: failReason,
          message: err instanceof Error ? err.message : String(err),
        });
        // Continue on per-document failure — one bad document should never
        // poison the whole ingest run.
      }
      advanceDocumentProgress(document);
      emitDocumentProgress();
    }

    /** @type {"complete" | "partial"} */
    const status = documentsFailed === 0 ? "complete" : "partial";
    const recordedId = ledger.recordScipIndex({
      ...indexRecord,
      documents_failed: documentsFailed,
      status,
      return_existing: effectiveForce,
    });
    return { status, recordedId };
  });
  const status = writeResult.status;
  const recordedId = writeResult.recordedId;

  const staleScip = documentsMissingText > 0;
  emit(onEvent, {
    kind: "atlas.scip.ingest.completed",
    scheme,
    language,
    source_languages: sourceLanguages,
    source_language_current: { ...sourceLanguageCurrent },
    source_language_total: { ...sourceLanguageTotals },
    fileset_hash: filesetHash,
    documents_ingested: documentsIngested,
    documents_failed: documentsFailed,
    documents_skipped: documentsSkipped,
    documents_missing_text: documentsMissingText,
    documents_range_clamped: documentsRangeClamped,
    stale_scip: staleScip,
    blobs_reused: blobsReused,
    external_symbols: externalsBound,
    ledger_entries_appended: ledgerEntriesAppended,
    scip_index_id: recordedId,
    status,
    current: totalDocuments,
    total: totalDocuments,
    percent: 100,
  });

  return {
    skipped: false,
    documents_ingested: documentsIngested,
    documents_failed: documentsFailed,
    documents_skipped: documentsSkipped,
    documents_missing_text: documentsMissingText,
    documents_range_clamped: documentsRangeClamped,
    stale_scip: staleScip,
    blobs_reused: blobsReused,
    external_symbols: externalsBound,
    covered_content_hashes: coveredHashes,
    ledger_entries_appended: ledgerEntriesAppended,
    scheme,
    fileset_hash: filesetHash,
    scip_index_id: recordedId,
    status,
  };
}

/**
 * Run the synchronous SCIP ledger write section under the shared SQLite gate
 * and one DB transaction when a real Ledger instance is available.
 *
 * @template T
 * @param {Ledger} ledger
 * @param {() => T} fn
 * @returns {Promise<T>}
 */
async function runScipIngestWrite(ledger, fn) {
  const anyLedger = /** @type {any} */ (ledger);
  const dbPath = typeof anyLedger?._dbPath === "function"
    ? anyLedger._dbPath()
    : "";
  const db = typeof anyLedger?._unsafeDb === "function"
    ? anyLedger._unsafeDb()
    : null;
  const run = () => (db && typeof db.transaction === "function"
    ? db.transaction(fn)()
    : fn());
  if (!dbPath) return run();
  return runSqliteWrite(dbPath, run, {
    label: "SCIP.ingest",
    waitMs: 120_000,
  });
}

/**
 * @param {{
 *   ledger: Ledger,
 *   branch: string,
 *   snapshot: Map<string, string | null> | null,
 *   repo_rel_path: string,
 *   content_hash: string,
 * }} args
 * @returns {number}
 */
function appendDocumentDelta({ ledger, branch, snapshot, repo_rel_path, content_hash }) {
  if (!branch || !snapshot) return 0;
  const before = snapshot.get(repo_rel_path) || null;
  if (before === content_hash) return 0;
  ledger.append({
    branch,
    op: before ? "modify" : "add",
    repo_rel_path,
    before_content_hash: before,
    after_content_hash: content_hash,
  });
  snapshot.set(repo_rel_path, content_hash);
  return 1;
}

function handleScipIndexDecodeFailure({ buf, err, onEvent, scipPath }) {
  const message = err instanceof Error ? err.message : String(err);
  const filesetHash = sha256Hex(buf);
  emit(onEvent, {
    kind: "atlas.scip.ingest.warning",
    scheme: "unknown",
    language: null,
    reason: "scip_decode_error",
    message: `SCIP index decode failed${scipPath ? ` for ${path.basename(scipPath)}` : ""}: ${message}`,
    fileset_hash: filesetHash,
    scip_path: scipPath || null,
  });
  emit(onEvent, {
    kind: "atlas.scip.ingest.skipped",
    scheme: "unknown",
    language: null,
    reason: "scip_decode_error",
    fileset_hash: filesetHash,
    scip_path: scipPath || null,
  });
  return {
    skipped: true,
    documents_ingested: 0,
    documents_failed: 1,
    documents_skipped: 0,
    blobs_reused: 0,
    external_symbols: 0,
    covered_content_hashes: [],
    ledger_entries_appended: 0,
    scheme: "unknown",
    fileset_hash: filesetHash,
    scip_index_id: null,
    status: "partial",
  };
}

/**
 * Normalize document paths and hydrate / validate source bytes before the
 * cache computes content hashes. This intentionally mutates the decoded
 * SCIP Index in-place; the index is single-use for each ingest. Real SCIP
 * indexers usually omit Document.text; in that case, resolve the source from
 * disk so content hashes match the normal tree-sitter warmer path. When
 * embedded text is present but disagrees with the current on-disk bytes, mark
 * the document as stale so it is skipped rather than attributed to the wrong
 * file version.
 *
 * @param {import("./decode.js").ScipIndex} index
 * @param {string} repoRoot
 * @returns {Promise<void>}
 */
async function prepareAndMutateDocumentText(index, repoRoot) {
  for (const doc of index.documents || []) {
    const repoRelPath = canonicalizePath(doc.relative_path, {
      repoRoot,
      projectRoot: index.metadata.project_root,
    });
    if (!repoRelPath) {
      doc.atlas_skip_reason = "path_not_canonical";
      doc.atlas_skip_message = `SCIP document path is not canonical repo-relative: ${doc.relative_path || "(empty)"}`;
      continue;
    }
    doc.relative_path = repoRelPath;
    const abs = resolveDocumentPath(index.metadata.project_root, repoRoot, repoRelPath);
    if (!abs) continue;
    if (doc.text) {
      try {
        const diskBytes = await fs.promises.readFile(abs);
        const embeddedBytes = Buffer.from(doc.text, "utf8");
        if (sha256Hex(diskBytes) !== sha256Hex(embeddedBytes)) {
          // Embedded text means the indexer gave us an exact file snapshot.
          // If the same path now has different bytes, ranges belong to the
          // older snapshot and must not be attached to the current file hash.
          doc.atlas_skip_reason = "text_mismatch";
          doc.atlas_skip_message = `SCIP embedded text for ${repoRelPath} differs from current on-disk bytes`;
        } else {
          doc.source_bytes = diskBytes;
          markMinifiedDocumentSkip(doc, repoRelPath, diskBytes);
        }
      } catch {
        // If the file is no longer on disk, keep the embedded text. It still
        // represents an explicit indexer payload and can be appended by callers
        // that intentionally ingest generated or out-of-tree sources.
      }
      continue;
    }
    try {
      const bytes = await fs.promises.readFile(abs);
      doc.text = bytes.toString("utf8");
      doc.source_bytes = bytes;
      markMinifiedDocumentSkip(doc, repoRelPath, bytes);
    } catch {
      doc.atlas_skip_reason = "missing_text";
      doc.atlas_skip_message = `SCIP document ${repoRelPath} has no embedded text and could not be read from disk`;
    }
  }
}

function markMinifiedDocumentSkip(doc, repoRelPath, bytes) {
  if (doc.atlas_skip_reason) return;
  if (isLikelyMinifiedPath(repoRelPath)) {
    doc.atlas_skip_reason = "minified_skip";
    doc.atlas_skip_message = "SCIP document path matches minified/bundled pattern";
    return;
  }
  const sample = Buffer.isBuffer(bytes)
    ? bytes.subarray(0, MINIFIED_SAMPLE_BYTES)
    : Buffer.from(bytes || "").subarray(0, MINIFIED_SAMPLE_BYTES);
  const inspection = inspectSampleForMinified(sample);
  if (inspection.minified) {
    doc.atlas_skip_reason = "minified_skip";
    doc.atlas_skip_message = `SCIP document content looks minified (maxLine=${Math.round(inspection.maxLineLen)} meanLine=${Math.round(inspection.meanLineLen)})`;
  }
}

/**
 * @param {string | undefined} projectRoot
 * @param {string} repoRoot
 * @param {string} repoRelPath
 * @returns {string}
 */
function resolveDocumentPath(projectRoot, repoRoot, repoRelPath) {
  const candidates = [];
  const root = normalizeProjectRoot(projectRoot);
  if (root) candidates.push(path.resolve(root, repoRelPath));
  candidates.push(path.resolve(repoRoot, repoRelPath));
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // Try the next candidate.
    }
  }
  return candidates[candidates.length - 1] || "";
}

/**
 * @param {string | undefined} projectRoot
 * @returns {string}
 */
function normalizeProjectRoot(projectRoot) {
  const raw = String(projectRoot || "").trim();
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try { return fileURLToPath(raw); } catch { return ""; }
  }
  return path.isAbsolute(raw) ? raw : "";
}

/**
 * @param {import("./decode.js").ScipIndex} index
 * @returns {string}
 */
function inferSchemeFromIndex(index) {
  // ToolInfo.name typically matches scheme ("scip-typescript" etc.) for
  // sourcegraph indexers; fall back to first external symbol's scheme
  // when ToolInfo is absent.
  const fromTool = (index.metadata.tool_info.name || "").trim();
  if (fromTool) return fromTool;
  for (const ext of index.external_symbols) {
    const scheme = schemeFromSymbol(ext.symbol);
    if (scheme) return scheme;
  }
  for (const doc of index.documents || []) {
    for (const sym of doc.symbols || []) {
      const scheme = schemeFromSymbol(sym.symbol);
      if (scheme) return scheme;
    }
    for (const occ of doc.occurrences || []) {
      const scheme = schemeFromSymbol(occ.symbol);
      if (scheme) return scheme;
    }
  }
  return "";
}

/**
 * @param {string} symbol
 * @returns {string}
 */
function schemeFromSymbol(symbol) {
  const raw = String(symbol || "").trim();
  if (!raw || raw.startsWith("local ")) return "";
  const space = raw.indexOf(" ");
  return space > 0 ? raw.slice(0, space) : "";
}

function normalizeNativeRowDocuments(documents) {
  return (Array.isArray(documents) ? documents : []).map((doc) => ({
    repo_rel_path: String(doc?.repo_rel_path ?? doc?.repoRelPath ?? ""),
    content_hash: String(doc?.content_hash ?? doc?.contentHash ?? ""),
    byte_size: nativeRowsNumber(doc, "byte_size", "byteSize"),
    range_clamp_count: nativeRowsNumber(doc, "range_clamp_count", "rangeClampCount"),
    lang: String(doc?.lang || ""),
    symbols: Array.isArray(doc?.symbols) ? doc.symbols : [],
    edges: Array.isArray(doc?.edges) ? doc.edges : [],
    skip_reason: doc?.skip_reason ?? doc?.skipReason ?? null,
    skip_message: doc?.skip_message ?? doc?.skipMessage ?? null,
  }));
}

function nativeRowsNumber(value, snake, camel) {
  const n = Number(value?.[snake] ?? value?.[camel] ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function bindNativeExternalMonikers(ledger, nativeRows, onBind) {
  const externalIds = plainObject(nativeRows?.external_ids ?? nativeRows?.externalIds) || {};
  const externalMonikers = plainObject(nativeRows?.external_monikers ?? nativeRows?.externalMonikers) || {};
  const byNativeId = new Map();
  for (const [rawSymbol, nativeIdRaw] of Object.entries(externalIds)) {
    const nativeId = Number(nativeIdRaw);
    const moniker = plainObject(externalMonikers[rawSymbol]);
    if (!Number.isFinite(nativeId) || !moniker) continue;
    const id = ledger.upsertExternalSymbol({
      scheme: String(moniker.scheme || ""),
      manager: String(moniker.manager || ""),
      package_name: String(moniker.package_name ?? moniker.packageName ?? ""),
      package_version: String(moniker.package_version ?? moniker.packageVersion ?? ""),
      descriptor: String(moniker.descriptor || ""),
      display_name: String(moniker.display_name ?? moniker.displayName ?? "") || null,
    });
    byNativeId.set(nativeId, id);
    onBind();
  }
  return byNativeId;
}

function bindNativeParseResult(document, externalIdMap) {
  return {
    repo_rel_path: document.repo_rel_path,
    content_hash: document.content_hash,
    lang: document.lang || sourceLanguageForDocument(document) || "unknown",
    symbols: document.symbols.map(normalizeNativeSymbol),
    edges: document.edges.map((edge) => normalizeNativeEdge(edge, externalIdMap)),
  };
}

function normalizeNativeSymbol(symbol) {
  return {
    ...symbol,
    content_hash: String(symbol?.content_hash ?? symbol?.contentHash ?? ""),
    local_id: Number(symbol?.local_id ?? symbol?.localId ?? 0),
    qualified_name: symbol?.qualified_name ?? symbol?.qualifiedName ?? null,
    parent_local_id: symbol?.parent_local_id ?? symbol?.parentLocalId ?? null,
    repo_rel_path: String(symbol?.repo_rel_path ?? symbol?.repoRelPath ?? ""),
    range_start: nullableNumber(symbol?.range_start ?? symbol?.rangeStart),
    range_end: nullableNumber(symbol?.range_end ?? symbol?.rangeEnd),
    range_start_line: nullableNumber(symbol?.range_start_line ?? symbol?.rangeStartLine),
    range_end_line: nullableNumber(symbol?.range_end_line ?? symbol?.rangeEndLine),
    signature_hash: symbol?.signature_hash ?? symbol?.signatureHash ?? null,
    signature_text: symbol?.signature_text ?? symbol?.signatureText ?? null,
    body_identifiers: symbol?.body_identifiers ?? symbol?.bodyIdentifiers ?? null,
    source: "scip",
  };
}

function normalizeNativeEdge(edge, externalIdMap) {
  const out = {
    ...edge,
    from_content_hash: String(edge?.from_content_hash ?? edge?.fromContentHash ?? ""),
    from_local_id: Number(edge?.from_local_id ?? edge?.fromLocalId ?? 0),
    edge_id: Number(edge?.edge_id ?? edge?.edgeId ?? 0),
    to_content_hash: edge?.to_content_hash ?? edge?.toContentHash ?? null,
    to_local_id: nullableNumber(edge?.to_local_id ?? edge?.toLocalId),
    to_external_id: null,
    to_name: String(edge?.to_name ?? edge?.toName ?? ""),
    range_start: Number(edge?.range_start ?? edge?.rangeStart ?? 0),
    range_end: Number(edge?.range_end ?? edge?.rangeEnd ?? 0),
    range_start_line: Number(edge?.range_start_line ?? edge?.rangeStartLine ?? 1),
    range_end_line: Number(edge?.range_end_line ?? edge?.rangeEndLine ?? 1),
    confidence: Number(edge?.confidence ?? 98),
    source: "scip",
  };
  const nativeExternalId = edge?.to_external_id ?? edge?.toExternalId;
  if (nativeExternalId != null) {
    const realId = externalIdMap.get(Number(nativeExternalId));
    if (realId == null) {
      throw new Error(`native SCIP external id ${nativeExternalId} was not bound`);
    }
    out.to_external_id = realId;
  }
  return out;
}

function nullableNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * @param {Array<Record<string, any>>} documents
 * @returns {string}
 */
function collectLangs(documents) {
  const set = new Set();
  for (const doc of documents || []) {
    const lang = sourceLanguageForDocument(doc);
    if (lang) set.add(lang);
  }
  return sortLanguageTags([...set]).join(",");
}

/**
 * @param {Array<Record<string, any>>} documents
 * @returns {string[]}
 */
function collectSourceLanguages(documents) {
  const set = new Set();
  for (const doc of documents || []) {
    const lang = sourceLanguageForDocument(doc);
    if (lang) set.add(lang);
  }
  return sortLanguageTags([...set]);
}

/**
 * @param {Array<Record<string, any>>} documents
 * @returns {Record<string, number>}
 */
function collectSourceLanguageCounts(documents) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const doc of documents || []) {
    const lang = sourceLanguageForDocument(doc);
    if (lang) counts[lang] = (counts[lang] || 0) + 1;
  }
  return sortCountRecord(counts);
}

function zeroCountsFromTotals(totals) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const lang of Object.keys(totals || {})) counts[lang] = 0;
  return counts;
}

function resetCounts(target, totals) {
  for (const key of Object.keys(target)) delete target[key];
  for (const lang of Object.keys(totals || {})) target[lang] = 0;
}

/**
 * SCIP indexers may omit Document.language or use one broad language for a
 * multi-extension indexer. Prefer the source path so scip-typescript indexes
 * `.js`/`.mjs` as `js` and `.ts`/`.tsx` as `ts`.
 *
 * @param {{ relative_path?: string, repo_rel_path?: string, language?: string, lang?: string }} doc
 * @returns {string}
 */
function sourceLanguageForDocument(doc) {
  const fromPath = languageForPath(doc?.relative_path || doc?.repo_rel_path || "");
  if (fromPath && fromPath !== "unknown") return fromPath;
  const rawDocLang = String(doc?.lang || doc?.language || "").trim();
  return rawDocLang ? normalizeLangFromScip(rawDocLang) : "";
}

const SOURCE_LANGUAGE_ORDER = ["ts", "js", "py", "php", "go", "rs", "java", "kt", "cs", "c", "cpp", "sh"];
function sortLanguageTags(values) {
  return values.sort((a, b) => {
    const ai = SOURCE_LANGUAGE_ORDER.indexOf(a);
    const bi = SOURCE_LANGUAGE_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });
}

/**
 * @param {Record<string, number>} counts
 * @returns {Record<string, number>}
 */
function sortCountRecord(counts) {
  /** @type {Record<string, number>} */
  const sorted = {};
  for (const lang of sortLanguageTags(Object.keys(counts || {}))) {
    sorted[lang] = counts[lang];
  }
  return sorted;
}

/**
 * @param {string} relativePath
 * @param {{ repoRoot?: string, projectRoot?: string }} [opts]
 * @returns {string}
 */
function canonicalizePath(relativePath, opts = {}) {
  if (!relativePath) return "";
  let raw = String(relativePath).trim();
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try { raw = fileURLToPath(raw); } catch { return ""; }
  }

  const direct = normalizeRepoPath(raw);
  if (direct) return direct;

  const roots = [
    normalizeProjectRoot(opts.projectRoot),
    normalizeProjectRoot(opts.repoRoot),
  ].filter(Boolean);
  if (!isAbsoluteLike(raw) || roots.length === 0) return "";

  for (const root of roots) {
    const rel = repoRelativeFromAbsolute(raw, root);
    if (rel) return rel;
  }
  return "";
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isAbsoluteLike(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * @param {((event: { kind: string, [k: string]: any }) => void) | undefined} onEvent
 * @param {{ kind: string, [k: string]: any }} event
 */
function emit(onEvent, event) {
  if (typeof onEvent !== "function") return;
  try { onEvent(event); } catch { /* observability never fails the caller */ }
}

/**
 * Convenience: enumerate every `.scip` file under a directory. Used by the
 * warmer when the repo's staged SCIP directory contains indexer outputs
 * (one per language).
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listScipFiles(dir) {
  if (!dir) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (/** @type {any} */ (err)?.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.toLowerCase().endsWith(".scip")) continue;
    out.push(path.join(dir, ent.name));
  }
  return out.sort();
}
