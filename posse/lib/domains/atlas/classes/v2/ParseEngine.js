// @ts-check
//
// ATLAS v2 ParseEngine — pipeline-driven parse/view materialization.
//
// Responsibilities:
//   * handleWarmJob(payload) — async, called by the `atlas_warm` job
//     executor. Dispatches by purpose (wi / main-incremental / main-full)
//     and returns a AtlasWarmJobResult describing what was done.
//   * mountForWorktree(...) / mountForWorktreeAsync(...) — promote a
//     warmed view file into the worktree's view path, fall back to
//     clone-from-main, fall back to building fresh from the ledger.
//   * cleanupWiView(...) / cleanupWiViewAsync(...) — delete the warmed
//     file and (optionally) the worktree's mounted view.
//   * replayMerge(...) — async; called at merge-to-main time. Wraps
//     Ledger.replayPartition with a small bit of branch-status
//     bookkeeping.
//
// Warming is BEST-EFFORT. Any failure surfaces in the result's `skipped`
// list and never blocks pipeline work. Callers should treat the result
// as informational, not authoritative.

import fs from "fs";
import path from "path";
import { ViewBuilder } from "./ViewBuilder.js";
import { View } from "./View.js";
import { OrderedDocumentIntake } from "./OrderedDocumentIntake.js";
import {
  exportTreeCompressionMlSnapshot,
  importTreeCompressionMlSnapshot,
} from "../../functions/v2/tree-compression.js";
import { isCanonicalRepoPath } from "../../functions/v2/paths.js";
import {
  ledgerBranchForWi,
  mainViewPath,
  warmedViewPath,
  warmedViewsDir,
  worktreeViewPath,
} from "../../functions/v2/runtime-paths.js";
import {
  formatAtlasError,
  isVerboseAtlasErrors,
  logAtlasError,
} from "../../functions/v2/verbose-errors.js";
import { ingestView } from "../../functions/v2/embeddings/ingest.js";
import { reconcileEmbeddings, resumeEmbeddingsSlice } from "../../functions/v2/embeddings/on-demand.js";
import { ATLAS_EMBEDDINGS_WARM_SLICE_SYMBOLS } from "../../functions/v2/contracts/jobs.js";
import { errorForTelemetry, recordEmbeddingForensics } from "../../functions/v2/embeddings/forensics.js";
import { cleanupStaleEmbeddingDirs, openEmbeddingResources } from "../../functions/v2/embeddings/resources.js";
import {
  DOCUMENTATION_TEXT_SHAPE_VERSION,
  embeddingKeysForSymbol,
} from "../../functions/v2/embeddings/documentation-channel.js";
import { openViewWithMeta, removeSqliteFile, viewFreshness } from "../../functions/v2/view-health.js";
import { viewCanServeBranch } from "../../functions/v2/view-can-serve.js";
import { sourceStatRecord, sourceStatMatches } from "../../functions/v2/source-stats.js";
import { languageTagForExtension } from "../../functions/v2/language-tag.js";
import { isMergeAlreadyReflected } from "../../functions/v2/merge-reflection.js";
import {
  recordStaleEmbeddingHash,
  staleEmbeddingHashes,
  pruneStaleEmbeddingHashes,
  pruneEmbeddingIndexToCurrentView,
} from "../../functions/v2/embeddings/stale-tracking.js";
import { runSqliteWrite } from "../../../../shared/concurrency/functions/sqlite-gate.js";
import { invalidateStorageCacheNativeAsync } from "../../functions/v2/native/storage.js";
import {
  inspectSampleForMinified,
  isOversizedForParsing,
  isLikelyMinifiedPath,
  MAX_PARSE_FILE_BYTES,
  MINIFIED_SAMPLE_BYTES,
} from "../../functions/v2/parser/index-filters.js";
import { sha256Hex } from "../../functions/v2/hash.js";
import { ingestScipFile, listScipFiles } from "../../functions/v2/scip/ingester.js";
import { mergeLayerRows } from "../../functions/v2/ledger/layer-merge.js";
import { startOnnxRefresh } from "../../functions/v2/parse/onnx-index-runner.js";
import { hasLanguageSemantics } from "../../functions/v2/resolver/adapters/registry.js";
import { ensureScipStaged, stageScipBatches } from "../../functions/v2/scip/stager.js";
import {
  normalizeAtlasScipMode,
  shouldRunScipPhase,
} from "../../../integrations/functions/atlas-v2-mode.js";
import {
  normalizedScipPath,
  scipBasenameSourceLanguages,
  scipEventToProgressText,
} from "../../functions/v2/scip-progress.js";
import {
  normalizeTreeCompressionMode,
  positiveIntOrDefault,
  shouldRunMlTreeCompressionReseed,
} from "../../functions/v2/tree-compression-policy.js";
import { MAX_FULL_WARM_PATHS, walkRepoFilesAsync } from "../../functions/v2/warm-walk.js";

// Re-exported for the warmer test suite, which imports this decision helper
// from the engine's public surface.
export { shouldRunMlTreeCompressionReseed };

/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmJobPayload} AtlasWarmJobPayload */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmJobResult} AtlasWarmJobResult */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmPurpose} AtlasWarmPurpose */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmSkip} AtlasWarmSkip */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewSymbol} ViewSymbol */

/**
 * @typedef {Object} EmbeddingIngestScope
 * @property {"incremental"} kind
 * @property {number} previousLedgerSeq
 * @property {number} nextLedgerSeq
 * @property {string[]} touchedPaths
 * @property {ViewSymbol[]} onlySymbols
 */
/** @typedef {import("../../functions/v2/contracts/schemas.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../../functions/v2/contracts/schemas.js").ParseResult} ParseResult */
/** @typedef {import("../../functions/v2/contracts/api.js").ParserAdapter} ParserAdapter */
/** @typedef {import("./Ledger.js").Ledger} Ledger */

function nowMs() {
  return Date.now();
}

function recordIntakeTelemetry(base, kind, detail = {}) {
  if (process.env.POSSE_INTAKE_BENCH_TRACE !== "1" || !base) return;
  const target = /** @type {any} */ (base);
  if (!target.intake_telemetry) {
    target.intake_telemetry = { schema_version: 1, started_at_ms: nowMs(), events: [] };
  }
  const telemetry = target.intake_telemetry;
  // Keep benchmark payloads bounded even for very large repositories.
  if (telemetry.events.length >= 20_000) {
    telemetry.events_dropped = Number(telemetry.events_dropped || 0) + 1;
    return;
  }
  telemetry.events.push({
    at_ms: nowMs() - telemetry.started_at_ms,
    kind,
    ...detail,
  });
}

/**
 * @param {Ledger} ledger
 * @param {string} contentHash
 * @param {{ layerMerge?: boolean }} [options]
 * @returns {boolean}
 */
function ledgerHasCurrentParsedBlob(ledger, contentHash, options = {}) {
  if (options.layerMerge === true && typeof /** @type {any} */ (ledger).hasCurrentTreeSitterLayer === "function") {
    return /** @type {any} */ (ledger).hasCurrentTreeSitterLayer(contentHash);
  }
  if (typeof /** @type {any} */ (ledger).hasCurrentParsedBlob === "function") {
    return /** @type {any} */ (ledger).hasCurrentParsedBlob(contentHash);
  }
  return typeof ledger.hasBlob === "function" ? ledger.hasBlob(contentHash) : false;
}

/**
 * SCIP runs before tree-sitter during warmup. Some SCIP indexers, notably the
 * PHP indexer, omit procedural declarations while still marking the blob as
 * parsed. Let tree-sitter merge in its symbol rows for those blobs instead of
 * skipping them as already current.
 *
 * @param {{ ledger: Ledger, contentHash: string | null, repoRelPath: string }} args
 * @returns {boolean}
 */
function shouldMergeTreeSitterRowsForScipBlob({ ledger, contentHash, repoRelPath }) {
  if (!contentHash || path.extname(repoRelPath).toLowerCase() !== ".php") return false;
  const db = typeof /** @type {any} */ (ledger)._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
  if (!db) return false;
  try {
    const rows = /** @type {Array<{ source: string, cnt: number }>} */ (
      db.prepare(
        `SELECT source, COUNT(*) AS cnt
         FROM blob_symbols
         WHERE content_hash = ?
         GROUP BY source`,
      ).all(contentHash)
    );
    const hasScip = rows.some((row) => row.source === "scip" && Number(row.cnt || 0) > 0);
    const hasTreeSitter = rows.some((row) => row.source === "treesitter" && Number(row.cnt || 0) > 0);
    return hasScip && !hasTreeSitter;
  } catch {
    return false;
  }
}

const VIEW_WRITE_LOCKS = new Map();

/**
 * Serialize destructive/open-for-write work per view DB path. The worker
 * normally gates warm jobs at the ledger level, but tests and direct callers
 * can still target the same cache file concurrently.
 *
 * @template T
 * @param {string} viewPath
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withViewWriteLock(viewPath, fn) {
  const raw = path.resolve(String(viewPath || "view")).replace(/\\/g, "/");
  const key = process.platform === "win32" ? raw.toLowerCase() : raw;
  const previous = VIEW_WRITE_LOCKS.get(key) || Promise.resolve();
  const waitForPrevious = Promise.resolve(previous).catch(() => {});
  let release = () => {};
  const current = waitForPrevious.then(() => new Promise((resolve) => { release = () => resolve(undefined); }));
  VIEW_WRITE_LOCKS.set(key, current);
  await waitForPrevious;
  try {
    return await fn();
  } finally {
    release();
    if (VIEW_WRITE_LOCKS.get(key) === current) VIEW_WRITE_LOCKS.delete(key);
  }
}

/**
 * Idempotent move (Windows-safe): try rename first, fall back to
 * copy+unlink on EXDEV. WAL sidecars are best-effort moved too.
 *
 * @param {string} from
 * @param {string} to
 */
function safeMoveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
  for (const sfx of ["-wal", "-shm"]) {
    if (fs.existsSync(from + sfx)) {
      try { fs.renameSync(from + sfx, to + sfx); }
      catch {
        try { fs.copyFileSync(from + sfx, to + sfx); fs.unlinkSync(from + sfx); }
        catch { /* sidecars are advisory; SQLite recovers without them */ }
      }
    }
  }
}

/**
 * Patch the meta table on an already-built view file to point at a
 * different branch / lineage. Used when a warmed view originally
 * targeted main is mounted into a worktree whose ledger branch has now
 * been forked off main. Symbol IDs and edges remain valid because they
 * are content-addressed.
 *
 * @param {string} viewPath
 * @param {{ branch: string, parent_branch?: string | null, parent_seq?: number | null, ledger_seq?: number, built_at?: string }} meta
 */
function patchViewBranchMeta(viewPath, meta) {
  const view = View.mount({ dbPath: viewPath, mode: "readwrite" });
  try {
    const db = view._unsafeDb();
    const set = db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const del = db.prepare("DELETE FROM meta WHERE key = ?");
    set.run("branch", meta.branch);
    set.run("built_at", meta.built_at || new Date().toISOString());
    if (meta.parent_branch) set.run("parent_branch", meta.parent_branch);
    else del.run("parent_branch");
    if (meta.parent_seq != null) set.run("parent_seq", String(meta.parent_seq));
    else del.run("parent_seq");
    if (Number.isInteger(meta.ledger_seq)) set.run("ledger_seq", String(meta.ledger_seq));
  } finally {
    view.close();
  }
}

export class ParseEngine {
  /** @type {Ledger} */
  #ledger;
  /** @type {ViewBuilder} */
  #builder;
  /** @type {ParserAdapter | null} */
  #parser;
  /** @type {string} */
  #repoRoot;
  /** @type {string} */
  #defaultBranch;
  /** @type {Record<string, unknown>} */
  #runtimeConfig;
  /** @type {string} */
  #scipMode;
  /** @type {string} */
  #scipDir;
  /** @type {boolean} */
  #viewLayerMerge;
  /** @type {string} */
  #treeCompressionMode;
  /** @type {number} */
  #treeCompressionMaxSeeds;
  /** @type {((event: Record<string, unknown>) => void) | null} */
  #onProgress;
  /** @type {boolean} */
  #defaultBranchEnsured = false;
  /** @type {boolean} */
  #deferEmbeddings;
  /** @type {AbortSignal | null} */
  #signal;
  /** @type {Array<{ viewPath: string, base: AtlasWarmJobResult, embeddingScope?: EmbeddingIngestScope | null, run?: () => Promise<void> }>} */
  #pendingEmbeddingIngests = [];

  /**
   * @param {{
   *   ledger: Ledger,
   *   viewBuilder?: ViewBuilder,
   *   parserAdapter?: ParserAdapter | null,
   *   repoRoot: string,
   *   defaultBranch?: string,
   *   config?: Record<string, unknown>,
   *   scipMode?: string,
   *   scipDir?: string,
   *   onProgress?: ((event: Record<string, unknown>) => void) | null,
   *   deferEmbeddings?: boolean,
   *   signal?: AbortSignal | null,
   * }} args
   */
  constructor({ ledger, viewBuilder, parserAdapter, repoRoot, defaultBranch = "main", config, scipMode, scipDir, onProgress = null, deferEmbeddings = false, signal = null }) {
    if (!ledger) throw new TypeError("ParseEngine: ledger is required");
    if (!repoRoot) throw new TypeError("ParseEngine: repoRoot is required");
    this.#ledger = ledger;
    this.#builder = viewBuilder || new ViewBuilder();
    this.#parser = parserAdapter || null;
    this.#repoRoot = repoRoot;
    this.#defaultBranch = String(defaultBranch || "main").trim() || "main";
    this.#runtimeConfig = config && typeof config === "object" ? { ...config } : {};
    this.#scipMode = normalizeAtlasScipMode(scipMode ?? String(this.#runtimeConfig.scipMode || ""));
    this.#scipDir = String(scipDir || this.#runtimeConfig.scipDir || path.join(this.#repoRoot, ".posse", "atlas", "scip"));
    this.#viewLayerMerge = this.#runtimeConfig?.viewLayerMerge === true;
    this.#treeCompressionMode = normalizeTreeCompressionMode(
      this.#runtimeConfig?.treeCompressionMode
        ?? this.#runtimeConfig?.atlasTreeCompressionMode
        ?? this.#runtimeConfig?.atlas_tree_compression_mode,
    );
    this.#treeCompressionMaxSeeds = positiveIntOrDefault(
      this.#runtimeConfig?.treeCompressionMaxSeeds
        ?? this.#runtimeConfig?.atlasTreeCompressionMaxSeeds
        ?? this.#runtimeConfig?.atlas_tree_compression_max_seeds,
      80,
    );
    this.#onProgress = typeof onProgress === "function" ? onProgress : null;
    this.#deferEmbeddings = deferEmbeddings === true;
    this.#signal = signal && typeof signal === "object" ? signal : null;
    // Default-branch ledger init is deferred until the first job/mount
    // entry point so a transient ledger fault surfaces through the
    // appropriate error contract (skipped record for handleWarmJob,
    // throw for the synchronous mount/replay paths) instead of leaking
    // out of `new Warmer(...)`.
  }

  // Idempotent default-branch init. Cheap on the hot path: one
  // getBranch lookup; first call may also issue ensureRootBranch
  // (an awaited native-worker write).
  async #ensureDefaultBranch() {
    if (this.#defaultBranchEnsured) return;
    if (!this.#ledger.getBranch(this.#defaultBranch) && typeof this.#ledger.ensureRootBranch === "function") {
      await this.#ledger.ensureRootBranch(this.#defaultBranch);
    }
    this.#defaultBranchEnsured = true;
  }

  #viewBuildOptions() {
    return {
      repoRoot: this.#repoRoot,
      layerMerge: this.#viewLayerMerge,
      treeCompressionMode: this.#treeCompressionMode,
      treeCompressionMaxSeeds: this.#treeCompressionMaxSeeds,
    };
  }

  #viewMetaMatchesBuildMode(meta) {
    return viewFreshness(meta, null, { layerMerge: this.#viewLayerMerge }).current === true;
  }

  #emitProgress(event) {
    if (!this.#onProgress) return;
    try { this.#onProgress(event); } catch { /* progress callbacks are observational */ }
  }

  #throwIfAborted() {
    if (!this.#signal?.aborted) return;
    const reason = this.#signal.reason;
    const err = reason instanceof Error ? reason : new Error(String(reason || "ATLAS warm aborted"));
    if (!err.name || err.name === "Error") err.name = "AbortError";
    try { /** @type {any} */ (err).code ||= "ABORT_ERR"; } catch { /* best effort */ }
    throw err;
  }

  /**
   * Forward a ViewBuilder `phase:"tree"` event as a `stage:"tree"` progress
   * line. The tree refresh (tree-derived + compression seeds) drives its own
   * boot-panel bar, separate from the view/zip merge bar; `status` carries the
   * terminal ok/failed verdict so a native-unavailable compression failure is
   * visible at boot instead of only in derived_state_runs.
   *
   * @param {{ current?: number, total?: number, detail?: string, status?: string }} e
   */
  #emitTreeProgress(e) {
    const frac = (e?.total > 0) ? Math.max(0, Math.min(1, e.current / e.total)) : 0;
    this.#emitProgress({
      kind: "line",
      stream: "system",
      stage: "tree",
      text: e?.detail || "building tree",
      percent: frac * 100,
      status: e?.status ?? null,
      progress_current: e?.current ?? null,
      progress_total: e?.total ?? null,
    });
  }

  /**
   * Emit a warmup stage and yield once so boot progress can repaint before
   * entering a synchronous parser / SQLite / filesystem section.
   *
   * @param {string} stage
   * @param {string} text
   * @param {Record<string, unknown>} [extra]
   * @returns {Promise<void>}
   */
  async #emitStage(stage, text, extra = {}) {
    this.#throwIfAborted();
    this.#emitProgress({
      kind: "line",
      stream: "system",
      stage,
      text,
      ...extra,
    });
    await this.#yieldForProgress();
    this.#throwIfAborted();
  }

  /**
   * Consume staged `.scip` files (Phase 0) when the DB-backed
   * `atlas_scip_mode` setting enables it. Best-effort: any failure surfaces in the result's
   * `skipped` list and is also emitted as a progress event, but the
   * outer warm job continues.
   *
   * `on-demand` / `both` currently share the same stage-then-consume boot
   * behavior as `on`; finer request-scoped indexing can layer on later.
   *
   * @param {AtlasWarmJobResult} base
   * @param {AtlasWarmPurpose} purpose
   * @param {{ force?: boolean, forceIfMissing?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  async #runScipPhaseIfEnabled(base, purpose, opts = {}) {
    if (!this.#scipPhaseEligible(purpose)) return;
    // Sequential form used by `wi` (and any caller that can't overlap): stage
    // the `.scip` files, then ingest them. Boot main warms split these two so
    // generation can overlap tree-sitter parse — see handleWarmJob.
    const files = await this.#stageScipFiles(base, purpose);
    await this.#ingestScipFiles(base, files, opts);
  }

  /**
   * Whether SCIP staging/ingest applies for this warm purpose.
   * @param {AtlasWarmPurpose} purpose
   */
  #scipPhaseEligible(purpose) {
    // WI warms are intentionally hot-view materialization only. Repo-level
    // SCIP staging/intake belongs to main warms; letting a WI warm run it turns
    // a one-file follow-up into a boot-scale indexing job.
    return (
      purpose === "main-incremental" ||
      purpose === "main-full" ||
      purpose === "main-merge"
    );
  }

  /**
   * Phase 0a — STAGE (generate) the repo's `.scip` files. This spawns the
   * external indexer subprocess(es) and writes only to the scip dir on disk;
   * it performs NO ledger writes, so it is safe to run concurrently with
   * tree-sitter parse (which owns the path-delta log). Returns the staged
   * `.scip` paths for #ingestScipFiles to consume afterwards.
   *
   * @param {AtlasWarmJobResult} base
   * @param {AtlasWarmPurpose} purpose
   * @param {{ onFileReady?: ((file: string, info: Record<string, any>) => void) | null }} [opts]
   * @returns {Promise<string[]>}
   */
  async #stageScipFiles(base, purpose, opts = {}) {
    if (!this.#scipPhaseEligible(purpose)) return [];
    const mode = this.#scipMode;
    if (!shouldRunScipPhase(mode)) return [];
    if (mode === "on-demand" || mode === "both") {
      this.#emitProgress({
        kind: "line",
        stream: "system",
        stage: "scip",
        text: `atlas_scip_mode=${mode}; staging/consuming SCIP during warmup`,
      });
    }
    const scipDir = this.#scipDir;
    try {
      const staged = await ensureScipStaged({
        repoRoot: this.#repoRoot,
        scipDir,
        mode,
        config: this.#runtimeConfig,
        onProgress: (event) => this.#emitProgress(event),
        onFileReady: typeof opts.onFileReady === "function" ? opts.onFileReady : null,
      });
      for (const row of staged.results || []) {
        if (row?.ok !== false) continue;
        base.skipped.push({
          repo_rel_path: ".",
          reason: "parse_error",
          message: `SCIP staging failed for ${row.language || row.indexer || "unknown"}: ${row.error || row.reason || "unknown error"}`,
        });
      }
      return staged.files || [];
    } catch (err) {
      logAtlasError(`[Warmer.#stageScipFiles] ensureScipStaged(${scipDir}) threw:`, err);
      return [];
    }
  }

  /**
   * Generate path-preserving SCIP project views in deterministic batches.
   * Each ready artifact is acknowledged by the serialized intake queue; the
   * stager keeps at most the configured number of unacknowledged batches.
   *
   * @param {AtlasWarmJobResult} base
   * @param {AtlasWarmPurpose} purpose
   * @param {string[]} paths
   * @param {{
   *   onBatchReady?: ((file: string, info: Record<string, any>) => Promise<unknown> | unknown) | null,
   *   onFileUnavailable?: ((info: Record<string, any>) => Promise<unknown> | unknown) | null,
   * }} [opts]
   */
  async #stageScipBatches(base, purpose, paths, opts = {}) {
    if (!this.#scipPhaseEligible(purpose) || !shouldRunScipPhase(this.#scipMode)) return [];
    // A normal staged artifact represents the indexer's last full repository
    // view. Feed it into the same bounded intake lane, then let current-path
    // batches refresh any changed files while layer-mode parsing continues.
    const existingFiles = await listScipFiles(this.#scipDir).catch(() => []);
    if (existingFiles.length > 0) {
      for (const [batchOrdinal, file] of existingFiles.entries()) {
        if (typeof opts.onBatchReady === "function") {
          await opts.onBatchReady(file, {
            session_id: null,
            batch_ordinal: batchOrdinal,
            batch_count: existingFiles.length,
            repo_rel_paths: Array.isArray(paths) ? paths : [],
            source_languages: scipBasenameSourceLanguages(file),
            source: "staged",
          });
        }
      }
    }
    // A configured index command is intentionally opaque: unlike the built-in
    // registry plans it has no reliable source-extension map, so the batch
    // manifest cannot assign paths to it. Stage its normal persistent output
    // and feed that artifact through the same serialized intake callback.
    // Without this fallback boot reported that missing staging would be
    // retried, then produced zero batches forever.
    if (String(this.#runtimeConfig?.scipIndexCommand || "").trim()) {
      const files = await this.#stageScipFiles(base, purpose);
      for (const [batchOrdinal, file] of files.entries()) {
        if (typeof opts.onBatchReady === "function") {
          await opts.onBatchReady(file, {
            session_id: null,
            batch_ordinal: batchOrdinal,
            batch_count: files.length,
            repo_rel_paths: Array.isArray(paths) ? paths : [],
            source_languages: Array.isArray(this.#runtimeConfig?.scipLanguages)
              ? this.#runtimeConfig.scipLanguages
              : [],
            source: "configured",
          });
        }
      }
      /** @type {any} */ (base).scip_batch_session = null;
      /** @type {any} */ (base).scip_batches_staged = files.length;
      return files;
    }
    try {
      const staged = await stageScipBatches({
        repoRoot: this.#repoRoot,
        paths,
        scipDir: this.#scipDir,
        mode: this.#scipMode,
        config: this.#runtimeConfig,
        onProgress: (event) => this.#emitProgress(event),
        onBatchReady: opts.onBatchReady || null,
        onFileUnavailable: opts.onFileUnavailable || null,
      });
      for (const row of staged.results || []) {
        if (row?.ok !== false) continue;
        base.skipped.push({
          repo_rel_path: ".",
          reason: "parse_error",
          message: `SCIP batch ${Number(row.batchOrdinal) + 1} failed (${row.language || "unknown"}): ${row.error || "unknown error"}`,
        });
      }
      /** @type {any} */ (base).scip_batch_session = staged.sessionId || null;
      /** @type {any} */ (base).scip_batches_staged = staged.files?.length || 0;
      return staged.files || [];
    } catch (err) {
      logAtlasError(`[Warmer.#stageScipBatches] stageScipBatches(${this.#scipDir}) threw:`, err);
      base.skipped.push({
        repo_rel_path: ".",
        reason: "parse_error",
        message: `SCIP batch staging failed: ${formatAtlasError(err)}`,
      });
      return [];
    }
  }

  /**
   * Phase 0b — INGEST staged `.scip` files into the ledger, one at a time
   * (FIFO). Layer-mode boot warms may run this queue beside tree-sitter parse;
   * the queue serializes SCIP intake itself, and the boot worker keeps ledger
   * calls non-overlapping on the single JS thread.
   *
   * @param {AtlasWarmJobResult} base
   * @param {string[]} files
   * @param {{
   *   force?: boolean,
   *   forceIfMissing?: boolean,
   *   preparedFiles?: Map<string, { bytes: Buffer, producedAt: string | null }>,
   *   onDocumentsPrepared?: ((coverage: { documents: Array<{ repo_rel_path: string, content_hash: string }>, source_languages: string[] }) => Promise<void> | void) | null,
   *   onDocumentCommitted?: ((document: { repo_rel_path: string, content_hash: string, lang: string }) => Promise<void> | void) | null,
   *   expectedContentHashes?: Record<string, string> | null,
   * }} [opts]
   */
  async #ingestScipFiles(base, files, opts = {}) {
    if (!Array.isArray(files) || files.length === 0) return;
    for (const scipPath of files) {
      try {
        const prepared = opts.preparedFiles?.get(normalizedScipPath(scipPath)) || null;
        // A structured kind + language routing (not a bare stage line): the
        // boot matrix flips the parse cell to "intaking" the moment the file
        // is picked up, instead of showing "—" through the read/decode phase.
        await this.#emitStage("scip", `ingesting SCIP ${path.basename(scipPath)}`, {
          kind: "atlas.scip.ingest.reading",
          language: path.basename(scipPath, ".scip").toLowerCase() || null,
          source_languages: scipBasenameSourceLanguages(scipPath),
        });
        const result = await ingestScipFile({
          ledger: this.#ledger,
          scipPath,
          bytes: prepared?.bytes,
          repoRoot: this.#repoRoot,
          producedAt: prepared?.producedAt ?? null,
          branch: this.#defaultBranch,
          force: opts.force === true,
          forceIfMissing: opts.forceIfMissing === true,
          layerOnly: this.#viewLayerMerge,
          // In layer-merge mode Tree-sitter owns the branch path delta for
          // every file it parses. Letting SCIP also append those from its
          // independent startup snapshot races the tree walk and turns
          // identical add/add writes into a before_content_hash contract
          // failure. But SCIP-only documents — extensions the parser does not
          // support, or files too large to parse — have no other delta
          // writer, so SCIP must still append those or the view build (which
          // walks branch deltas) never sees them.
          appendLedgerEntries: true,
          shouldAppendPathDelta: this.#viewLayerMerge
            ? (document) => !this.#treeSitterOwnsPathDelta(document)
            : null,
          onDocumentsPrepared: opts.onDocumentsPrepared || undefined,
          onDocumentCommitted: opts.onDocumentCommitted || undefined,
          expectedContentHashes: opts.expectedContentHashes || undefined,
          onEvent: (event) => {
            // Forward the STRUCTURED ingest event (kind/language/current/total/
            // percent) so the boot matrix can drive the SCIP row through its
            // intaking phase to done. Previously this flattened every event to a
            // generic stage:"scip" line, stripping the kind — so the matrix only
            // ever saw "indexing" and the row hung at 100% indexing, never
            // showing intaking or reaching done. A `text` is added for the
            // activity-log/text-monitor renderer. `stage:"scip"` routes the
            // percents into the warm-readiness scip bucket, and the basename
            // source-language fallback keeps pre-decode events addressable in
            // the per-language matrix.
            this.#emitProgress({
              ...event,
              stage: event.stage || "scip",
              source_languages: Array.isArray(event.source_languages) && event.source_languages.length > 0
                ? event.source_languages
                : scipBasenameSourceLanguages(scipPath),
              stream: "system",
              text: scipEventToProgressText(event, scipPath),
            });
          },
        });
        if (result.skipped) continue;
        if (result.stale_scip) {
          // Drift evidence from intake: the index references files the tree no
          // longer has. Re-ingesting the same artifact is futile — surface it
          // so the operator (and a future auto-restage hook) can see it.
          base.skipped.push({
            repo_rel_path: ".",
            reason: "parse_error",
            message: `SCIP index ${path.basename(scipPath)} is stale: ${result.documents_missing_text} document(s) reference files missing from the tree — restage needed`,
          });
        }
        base.blobs_ingested += result.documents_ingested;
        base.blobs_reused += result.blobs_reused;
        base.ledger_entries_appended += result.ledger_entries_appended || 0;
      } catch (err) {
        logAtlasError(`[Warmer.#ingestScipFiles] ingest ${scipPath} threw:`, err);
        base.skipped.push({
          repo_rel_path: ".",
          reason: "parse_error",
          message: `SCIP ingest failed for ${path.basename(scipPath)}: ${formatAtlasError(err)}`,
        });
      }
    }
  }

  /**
   * Whether the layer-mode tree-sitter walk is the delta writer for a SCIP
   * document's path. The walk only appends for extensions the parser adapter
   * supports and files small enough to parse (parse failures still append —
   * they publish an empty/partial tree layer). Everything else is SCIP-only:
   * no other writer records the path, so SCIP appends its own delta.
   *
   * @param {{ repo_rel_path: string, byte_size: number }} document
   * @returns {boolean}
   */
  #treeSitterOwnsPathDelta(document) {
    const repoRelPath = String(document?.repo_rel_path || "");
    const ext = path.extname(repoRelPath).toLowerCase();
    if (!ext || !this.#parser || !this.#parser.supports(ext)) return false;
    if (isOversizedForParsing(Number(document?.byte_size || 0))) return false;
    return true;
  }

  /**
   * Pipelined SCIP intake queue. Stagers can add files as each indexer lands;
   * the next artifact read starts immediately while the previous artifact's
   * ledger writes remain serialized on the shared handle.
   *
   * @param {AtlasWarmJobResult} base
   * @param {{
   *   force?: boolean,
   *   forceIfMissing?: boolean,
   *   onDocumentsPrepared?: ((coverage: { documents: Array<{ repo_rel_path: string, content_hash: string }>, source_languages: string[] }) => Promise<void> | void) | null,
   *   onDocumentCommitted?: ((document: { repo_rel_path: string, content_hash: string, lang: string }) => Promise<void> | void) | null,
   * }} [opts]
   */
  #createScipIngestQueue(base, opts = {}) {
    /** @type {Set<string>} */
    const seen = new Set();
    let tail = Promise.resolve();
    const add = (scipPath, info = {}) => {
      const key = normalizedScipPath(scipPath);
      if (!key || seen.has(key)) return tail;
      seen.add(key);
      const file = String(scipPath);
      const scopePaths = (Array.isArray(info?.repo_rel_paths) ? info.repo_rel_paths : [])
        .map((repoRelPath) => String(repoRelPath || ""))
        .filter(Boolean);
      const expectedContentHashes = info?.content_hashes && typeof info.content_hashes === "object"
        ? info.content_hashes
        : null;
      // Read the next artifact immediately while the previous artifact's
      // decoded rows are writing through the serialized ledger tail.
      const prepared = Promise.all([
        fs.promises.readFile(file),
        fs.promises.stat(file).catch(() => null),
      ]).then(([bytes, stat]) => ({
        bytes,
        producedAt: stat?.mtime?.toISOString?.() || null,
        error: null,
      })).catch((error) => ({ bytes: null, producedAt: null, error }));
      tail = tail
        .catch((err) => {
          logAtlasError("[Warmer.#createScipIngestQueue] previous intake failed:", err);
        })
        .then(async () => {
          const ready = await prepared;
          if (ready.error || !ready.bytes) {
            const error = ready.error || new Error(`SCIP read failed for ${file}`);
            logAtlasError(`[Warmer.#createScipIngestQueue] read ${file} threw:`, error);
            base.skipped.push({
              repo_rel_path: ".",
              reason: "parse_error",
              message: `SCIP read failed for ${path.basename(file)}: ${formatAtlasError(error)}`,
            });
            return;
          }
          return this.#ingestScipFiles(base, [file], {
            ...opts,
            onDocumentsPrepared: typeof opts.onDocumentsPrepared === "function"
              ? (coverage) => opts.onDocumentsPrepared({
                  ...coverage,
                  ...(scopePaths.length > 0 ? { scope_paths: scopePaths } : {}),
                })
              : null,
            expectedContentHashes,
            preparedFiles: new Map([[key, ready]]),
          });
        });
      return tail;
    };
    return {
      add,
      addAll: (files) => {
        for (const file of Array.isArray(files) ? files : []) add(file);
        return tail;
      },
      idle: () => tail,
    };
  }

  /**
   * @param {AtlasWarmJobPayload} payload
   * @param {AtlasWarmJobResult} base
   * @returns {Promise<AtlasWarmJobResult>}
   */
  async #restageScip(payload, base) {
    const mode = this.#scipMode;
    if (!shouldRunScipPhase(mode)) {
      base.skipped.push({
        repo_rel_path: ".",
        reason: "unsupported_lang",
        message: "SCIP mode is disabled",
      });
      return base;
    }
    const language = String(payload?.language || "").trim().toLowerCase();
    /** @type {Record<string, any>} */
    const config = {
      ...this.#runtimeConfig,
      scipRestagePolicy: payload?.force ? "always" : (this.#runtimeConfig.scipRestagePolicy || "missing"),
    };
    if (language) config.scipLanguages = [language];
    const staged = await ensureScipStaged({
      repoRoot: this.#repoRoot,
      scipDir: this.#scipDir,
      mode,
      config,
      onProgress: (event) => this.#emitProgress(event),
    });
    base.paths_considered = Array.isArray(staged.files) ? staged.files.length : 0;
    if (staged.error) {
      base.skipped.push({
        repo_rel_path: ".",
        reason: "parse_error",
        message: staged.error,
      });
    }
    // Staging alone never ingests — surface "fresh artifacts exist" so the
    // warm-job executor can enqueue the main-incremental intake that consumes
    // them (ensureScipStaged returns staged:false for already_staged/no-op).
    if (staged.staged === true) base.scip_staged_fresh = true;
    return base;
  }

  #yieldForProgress() {
    return new Promise((resolve) => {
      if (typeof setImmediate === "function") setImmediate(resolve);
      else setTimeout(resolve, 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Job-driven (async) entry point
  // ---------------------------------------------------------------------------

  /**
   * @param {AtlasWarmJobPayload} payload
   * @returns {Promise<AtlasWarmJobResult>}
   */
  async handleWarmJob(payload) {
    const purpose = /** @type {AtlasWarmPurpose} */ (String(payload?.purpose || "wi"));
    const start = nowMs();
    /** @type {AtlasWarmJobResult} */
    const base = {
      purpose,
      paths_considered: Array.isArray(payload?.paths) ? payload.paths.length : 0,
      paths_indexed: 0,
      blobs_ingested: 0,
      blobs_reused: 0,
      ledger_entries_appended: 0,
      view_written: null,
      view_etag: null,
      duration_ms: 0,
      skipped: [],
    };
    try {
      await this.#emitStage("initializing", `warming ${purpose}`);
      await this.#ensureDefaultBranch();
      // Phase 0: consume any `.scip` files staged for this repo. Under the
      // layer model SCIP and tree-sitter each write their OWN source layer
      // (no flat first-writer-wins), so this ordering is no longer load-bearing
      // for correctness — the view merge combines A+B order-independently. It
      // still runs first here as a convenient sequencing; main-merge defers SCIP
      // until after replay to avoid pre-populating main with a path that
      // replayPartition still needs to apply.
      // Best-effort — a SCIP ingest failure never blocks the warm job.
      //
      // Ordering depends on the view model. Under the LAYER model
      // (#viewLayerMerge), tree-sitter and SCIP each write their own source
      // layer and the view merge combines them order-independently, so the boot
      // main warms overlap SCIP `.scip` generation + queued intake with
      // tree-sitter parse. Under the legacy FLAT model the
      // merge is first-writer-wins, so SCIP must seed blobs BEFORE tree-sitter
      // merges into them; those purposes keep the sequential pre-phase here.
      // main-merge always defers SCIP until after replay.
      const layerConcurrent = this.#viewLayerMerge === true;
      const sequentialScipPrePhase =
        purpose !== "main-merge" &&
        !(layerConcurrent && (purpose === "main-full" || purpose === "main-incremental"));
      if (sequentialScipPrePhase) {
        await this.#runScipPhaseIfEnabled(base, purpose);
      }
      switch (purpose) {
        case "wi":
          return finalize(await this.#warmWi(payload, base), start);
        case "wi-cleanup":
          return finalize(await this.#cleanupFromJob(payload, base), start);
        case "main-merge":
          return finalize(await this.#mergeToMain(payload, base), start);
        case "main-incremental": {
          if (!layerConcurrent) {
            // Flat path: SCIP already consumed in the sequential pre-phase.
            return finalize(await this.#warmIncremental(payload, base), start);
          }
          const branch = payload.branch || this.#defaultBranch;
          const embeddingIntake = this.#startDocumentEmbeddingIntake(base);
          try {
            // Overlap: deterministic path-preserving SCIP batches are staged
            // while tree-sitter parses. Each ready batch enters the serialized
            // intake lane immediately and its acknowledgement backpressures the
            // producer before more than the configured batch window can build.
            const scipQueue = this.#createScipIngestQueue(base, {
              onDocumentsPrepared: (coverage) => embeddingIntake?.documents.declareScipCoverage(coverage),
              onDocumentCommitted: (document) => embeddingIntake?.documents.markScip(document),
            });
            const stageScipPaths = async (paths) => {
              try {
                if (useBatchedScipStaging()) {
                  await this.#stageScipBatches(base, "main-incremental", paths, {
                    onBatchReady: async (file, info) => {
                      await scipQueue.add(file, info);
                      const lastPath = Array.isArray(info?.repo_rel_paths) ? info.repo_rel_paths.at(-1) : null;
                      if (lastPath) await embeddingIntake?.documents.waitUntilProcessed(lastPath);
                    },
                    onFileUnavailable: (info) => embeddingIntake?.documents.declareScipCoverage({
                      documents: [], source_languages: [],
                      scope_paths: [String(info?.repo_rel_path || "")].filter(Boolean),
                    }),
                  });
                } else {
                  const files = await this.#stageScipFiles(base, "main-incremental");
                  for (const file of files) await scipQueue.add(file, null);
                }
                await scipQueue.idle();
              } finally {
                embeddingIntake?.documents.finishScip();
              }
            };
            await this.#warmIncremental(payload, base, {
              buildView: false,
              documentIntake: embeddingIntake?.documents || null,
              stageScipPaths,
            });
            await this.#finishDocumentEmbeddingIntake(embeddingIntake, base);
            const hintPaths = /** @type {any} */ (base)._incrementalHintPaths || null;
            return finalize(
              await this.#updateBranchViewIncremental({ payload, branch, base, hintPaths }),
              start,
            );
          } catch (err) {
            await this.#abortDocumentEmbeddingIntake(embeddingIntake, err);
            throw err;
          }
        }
        case "main-full": {
          if (!layerConcurrent) {
            return finalize(await this.#warmFull(payload, base), start);
          }
          const branch = payload.branch || this.#defaultBranch;
          const embeddingIntake = this.#startDocumentEmbeddingIntake(base);
          try {
            const scipQueue = this.#createScipIngestQueue(base, {
              onDocumentsPrepared: (coverage) => embeddingIntake?.documents.declareScipCoverage(coverage),
              onDocumentCommitted: (document) => embeddingIntake?.documents.markScip(document),
            });
            const stageScipPaths = async (paths) => {
              try {
                if (useBatchedScipStaging()) {
                  await this.#stageScipBatches(base, "main-full", paths, {
                    onBatchReady: async (file, info) => {
                      await scipQueue.add(file, info);
                      const lastPath = Array.isArray(info?.repo_rel_paths) ? info.repo_rel_paths.at(-1) : null;
                      if (lastPath) await embeddingIntake?.documents.waitUntilProcessed(lastPath);
                    },
                    onFileUnavailable: (info) => embeddingIntake?.documents.declareScipCoverage({
                      documents: [], source_languages: [],
                      scope_paths: [String(info?.repo_rel_path || "")].filter(Boolean),
                    }),
                  });
                } else {
                  const files = await this.#stageScipFiles(base, "main-full");
                  for (const file of files) await scipQueue.add(file, null);
                }
                await scipQueue.idle();
              } finally {
                embeddingIntake?.documents.finishScip();
              }
            };
            await this.#warmFull(payload, base, {
              buildView: false,
              documentIntake: embeddingIntake?.documents || null,
              stageScipPaths,
            });
            await this.#finishDocumentEmbeddingIntake(embeddingIntake, base);
            return finalize(await this.#rebuildBranchView({ payload, branch, base }), start);
          } catch (err) {
            await this.#abortDocumentEmbeddingIntake(embeddingIntake, err);
            throw err;
          }
        }
        case "scip-restage":
          return finalize(await this.#restageScip(payload, base), start);
        case "embeddings":
          return finalize(await this.#resumeEmbeddings(payload, base), start);
        default:
          base.skipped = (payload?.paths || []).map((p) => ({
            repo_rel_path: String(p),
            reason: "unsupported_lang",
            message: `Unknown purpose '${purpose}'`,
          }));
          return finalize(base, start);
      }
    } catch (err) {
      if (isAbortLikeError(err)) throw err;
      // Treat any unexpected exception as "warming failed" — surface in
      // result rather than throwing. Callers (the executor) decide
      // whether to log as info or escalate.
      logAtlasError(`[Warmer.handleWarmJob] purpose=${purpose} threw:`, err);
      if (isVerboseAtlasErrors()) {
        // Verbose mode: re-throw so the caller sees the full stack on
        // the attempt rather than a list of generic per-path skips.
        throw err;
      }
      const message = formatAtlasError(err);
      const paths = Array.isArray(payload?.paths) ? payload.paths : [];
      if (paths.length > 0) {
        base.skipped = paths.map((p) => ({
          repo_rel_path: String(p),
          reason: "parse_error",
          message,
        }));
      } else {
        // No paths means no per-file detail to attach — but we still
        // need to surface SOMETHING or the failure disappears from the
        // result entirely. Use "." as the synthetic repo path matching
        // the pattern used by other purpose-level errors below.
        base.skipped = [{ repo_rel_path: ".", reason: "parse_error", message }];
      }
      return finalize(base, start);
    }
  }

  // ---------------------------------------------------------------------------
  // Mount/cleanup/replay ops (called inline by Workstream E hooks)
  // ---------------------------------------------------------------------------

  /**
   * Promote a warmed view into a worktree's view path, or fall back to
   * cloning main, or build fresh from the ledger.
   *
   * @param {{
   *   workItemId: number | string,
   *   ledgerBranch?: string,
   *   worktreePath: string,
   * }} args
   * @returns {Promise<{ from: "warmed" | "main-clone" | "ledger-build" | "none", viewPath: string | null }>}
   */
  async mountForWorktree({ workItemId, ledgerBranch, worktreePath }) {
    if (workItemId == null) throw new TypeError("mountForWorktree: workItemId is required");
    if (!worktreePath) throw new TypeError("mountForWorktree: worktreePath is required");
    await this.#ensureDefaultBranch();
    const dest = worktreeViewPath(worktreePath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const warmed = warmedViewPath(this.#repoRoot, workItemId);
    const branchName = ledgerBranch || ledgerBranchForWi(workItemId);
    const branchRec = this.#ledger.getBranch(branchName);
    const targetBranch = branchRec ? branchRec.name : this.#defaultBranch;
    if (fs.existsSync(dest)) {
      const existing = openViewWithMeta(dest, View);
      if (existing.ok) {
        const canServe = viewCanServeBranch({
          meta: existing.meta,
          ledger: this.#ledger,
          branch: targetBranch,
        });
        try { existing.view.close(); } catch { /* ignore */ }
        if (canServe.ok) {
          // Already mounted, readable, and current for the target branch.
          return { from: "none", viewPath: dest };
        }
      }
      // The worktree cache is disposable. If it exists but cannot pass
      // View.meta() or is stale for this branch, drop it so the normal
      // warm/main/ledger fallback path can produce a usable view.
      removeSqliteFile(dest);
    }

    if (fs.existsSync(warmed)) {
      const warmedProbe = openViewWithMeta(warmed, View);
      const canMountWarmed = warmedProbe.ok
        ? viewCanServeBranch({
            meta: warmedProbe.meta,
            ledger: this.#ledger,
            branch: targetBranch,
            allowParentBranchAtSeq: branchRec?.parent_seq ?? null,
            parentBranch: branchRec?.parent_branch || this.#defaultBranch,
            layerMerge: this.#viewLayerMerge,
          })
        : { ok: false };
      try { if (warmedProbe.ok) warmedProbe.view.close(); } catch { /* ignore */ }
      if (canMountWarmed.ok) {
        safeMoveFile(warmed, dest);
        if (branchRec) {
          patchViewBranchMeta(dest, {
            branch: branchRec.name,
            parent_branch: branchRec.parent_branch,
            parent_seq: branchRec.parent_seq,
            ledger_seq: this.#ledger.headSeq(branchRec.name),
          });
        }
        return { from: "warmed", viewPath: dest };
      }
      removeSqliteFile(warmed);
    }

    const main = mainViewPath(this.#repoRoot);
    if (fs.existsSync(main)) {
      const mainProbe = openViewWithMeta(main, View);
      const canCloneMain = mainProbe.ok
        ? viewCanServeBranch({
            meta: mainProbe.meta,
            ledger: this.#ledger,
            branch: targetBranch,
            allowParentBranchAtSeq: branchRec?.parent_seq ?? null,
            parentBranch: branchRec?.parent_branch || this.#defaultBranch,
            layerMerge: this.#viewLayerMerge,
          })
        : { ok: false };
      if (mainProbe.ok) {
        try { mainProbe.view.close(); } catch { /* ignore */ }
      }
      if (canCloneMain.ok) {
        this.#builder.cloneView({ sourcePath: main, destPath: dest });
        if (branchRec) {
          patchViewBranchMeta(dest, {
            branch: branchRec.name,
            parent_branch: branchRec.parent_branch,
            parent_seq: branchRec.parent_seq,
            ledger_seq: this.#ledger.headSeq(branchRec.name),
          });
        }
        return { from: "main-clone", viewPath: dest };
      }
      // Do not delete the main view just because it cannot serve THIS
      // worktree's branch. Main is a shared resource that other concurrent
      // WIs are cloning from; an unrelated fork-point mismatch should not
      // force every parallel mountForWorktree to fall back to a full
      // ledger-build. The main-incremental warm job is the place to refresh
      // main when it is genuinely stale.
    }

    // Last resort: build a view directly from the ledger. Slower, but
    // guarantees a usable view file even on a cold repo.
    const atSeq = this.#ledger.headSeq(targetBranch);
    await this.#builder.buildFrom({
      ledger: this.#ledger,
      branch: targetBranch,
      atSeq,
      outPath: dest,
      options: this.#viewBuildOptions(),
    });
    return { from: "ledger-build", viewPath: dest };
  }

  /**
   * Gate wrapper for mountForWorktree: serializes the mount against ATLAS's
   * other writes on the same view path (worker paths should await this method
   * rather than calling mountForWorktree directly).
   *
   * @param {{
   *   workItemId: number | string,
   *   ledgerBranch?: string,
   *   worktreePath: string,
   * }} args
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<{ from: "warmed" | "main-clone" | "ledger-build" | "none", viewPath: string | null }>}
   */
  mountForWorktreeAsync(args, opts = {}) {
    const key = args?.worktreePath ? worktreeViewPath(args.worktreePath) : this.#repoRoot;
    return runSqliteWrite(key, () => withViewWriteLock(key, () => this.mountForWorktree(args)), {
      label: opts.label || "Warmer.mountForWorktree",
      waitMs: opts.waitMs,
    });
  }

  /**
   * Delete a WI's warmed view and (optionally) its worktree-mounted
   * view. The ledger partition for the WI's branch is NOT touched —
   * that is the audit trail. Marks the branch abandoned if it exists.
   *
   * @param {{
   *   workItemId: number | string,
   *   worktreePath?: string,
   *   markBranchAbandoned?: boolean,
   * }} args
   * @returns {Promise<{ removed: string[] }>}
   */
  async cleanupWiView({ workItemId, worktreePath, markBranchAbandoned = false }) {
    if (workItemId == null) throw new TypeError("cleanupWiView: workItemId is required");
    await this.#ensureDefaultBranch();
    /** @type {string[]} */
    const removed = [];
    const targets = [warmedViewPath(this.#repoRoot, workItemId)];
    if (worktreePath) targets.push(worktreeViewPath(worktreePath));
    for (const t of targets) {
      for (const sfx of ["", "-wal", "-shm"]) {
        const p = t + sfx;
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); removed.push(p); }
          catch { /* best effort — file may be locked on Windows */ }
        }
      }
    }
    if (markBranchAbandoned) {
      const branchName = ledgerBranchForWi(workItemId);
      const rec = this.#ledger.getBranch(branchName);
      if (rec && rec.status === "active") {
        await this.#ledger.setBranchStatus(branchName, "abandoned");
      }
    }
    return { removed };
  }

  /**
   * @param {{
   *   workItemId: number | string,
   *   worktreePath?: string,
   *   markBranchAbandoned?: boolean,
   * }} args
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<{ removed: string[] }>}
   */
  cleanupWiViewAsync(args, opts = {}) {
    const key = args?.workItemId == null ? this.#repoRoot : warmedViewPath(this.#repoRoot, args.workItemId);
    return runSqliteWrite(key, () => this.cleanupWiView(args), {
      label: opts.label || "Warmer.cleanupWiView",
      waitMs: opts.waitMs,
    });
  }

  /**
   * Replay a WI branch's deltas onto another branch (typically main).
   * Marks the source branch merged when the replay succeeds.
   *
   * @param {{
   *   branch: string,
   *   ontoBranch?: string,
   *   fromSeq?: number,
   *   markMerged?: boolean,
   * }} args
   * @returns {Promise<{ entries: LedgerEntry[] }>}
   */
  async replayMerge({ branch, ontoBranch = null, fromSeq = 0, markMerged = true }) {
    if (!branch) throw new TypeError("replayMerge: branch is required");
    await this.#ensureDefaultBranch();
    const targetBranch = ontoBranch || this.#defaultBranch;
    const entries = await this.#ledger.replayPartition(branch, targetBranch, fromSeq);
    if (markMerged) {
      const rec = this.#ledger.getBranch(branch);
      if (rec && rec.status === "active") {
        await this.#ledger.setBranchStatus(branch, "merged");
      }
    }
    return { entries };
  }

  // ---------------------------------------------------------------------------
  // Per-purpose warm handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle a `wi-cleanup` warm job. Wraps the synchronous
   * `cleanupWiView` so terminal WIs get their warmed + worktree views
   * disposed through the same outbox-driven flow that all other ATLAS v2
   * pipeline events use. Idempotent — re-running on a clean WI is a
   * harmless no-op that returns an empty `removed` set.
   *
   * @param {AtlasWarmJobPayload} payload
   * @param {AtlasWarmJobResult} base
   * @returns {Promise<AtlasWarmJobResult>}
   */
  async #cleanupFromJob(payload, base) {
    if (payload?.work_item_id == null) {
      base.skipped = [{
        repo_rel_path: ".",
        reason: "unsupported_lang",
        message: "wi-cleanup payload missing work_item_id",
      }];
      return base;
    }
    try {
      await this.#emitStage("cleanup", `cleaning warmed view for WI#${payload.work_item_id}`);
      await this.cleanupWiViewAsync({
        workItemId: payload.work_item_id,
        markBranchAbandoned: false,
      }, {
        label: "Warmer.cleanupWiView.job",
      });
    } catch (err) {
      logAtlasError(`[Warmer.#cleanupFromJob] wi=${payload.work_item_id} threw:`, err);
      base.skipped = [{
        repo_rel_path: ".",
        reason: "parse_error",
        message: formatAtlasError(err),
      }];
    }
    return base;
  }

  /**
   * Replay a WI ledger partition onto main and rebuild the always-warm
   * main view. If a post-commit hook already indexed the same merge
   * into main, treat that as idempotent success rather than failing the
   * warm job: the source branch still gets marked merged and the main
   * view is refreshed from the resulting ledger head.
   *
   * @param {AtlasWarmJobPayload & { onto_branch?: string }} payload
   * @param {AtlasWarmJobResult} base
   * @returns {Promise<AtlasWarmJobResult>}
   */
  async #mergeToMain(payload, base) {
    const sourceBranch = payload.branch || (
      payload.work_item_id != null ? ledgerBranchForWi(payload.work_item_id) : null
    );
    const ontoBranch = payload.onto_branch || this.#defaultBranch;
    if (!sourceBranch) {
      base.skipped = [{
        repo_rel_path: ".",
        reason: "unsupported_lang",
        message: "main-merge payload missing source branch",
      }];
      return base;
    }
    if (!this.#ledger.getBranch(sourceBranch)) {
      base.skipped = [{
        repo_rel_path: ".",
        reason: "unsupported_lang",
        message: `Ledger branch '${sourceBranch}' does not exist`,
      }];
      return base;
    }
    if (!this.#ledger.getBranch(ontoBranch)) {
      base.skipped = [{
        repo_rel_path: ".",
        reason: "unsupported_lang",
        message: `Ledger destination branch '${ontoBranch}' does not exist`,
      }];
      return base;
    }

    try {
      await this.#emitStage("merge", `replaying ${sourceBranch} onto ${ontoBranch}`);
      const entries = await this.#ledger.replayPartition(
        sourceBranch,
        ontoBranch,
        Number(payload.from_seq || 0),
        { label: "Warmer.replayMerge" },
      );
      const rec = this.#ledger.getBranch(sourceBranch);
      if (rec && rec.status === "active") {
        await this.#emitStage("merge", `marking ${sourceBranch} merged`);
        await this.#ledger.setBranchStatus(sourceBranch, "merged", {
          label: "Warmer.replayMerge.setBranchStatus",
        });
      }
      const out = { entries };
      for (const entry of out.entries) {
        if (entry.op === "modify" || entry.op === "remove") {
          recordStaleEmbeddingHash(base, entry.before_content_hash);
        }
      }
      base.ledger_entries_appended += out.entries.length;
      base.paths_considered = out.entries.length;
      base.paths_indexed = out.entries.length;
    } catch (err) {
      if (!isMergeAlreadyReflected({
        ledger: this.#ledger,
        branch: sourceBranch,
        ontoBranch,
        fromSeq: Number(payload.from_seq || 0),
      })) {
        logAtlasError(`[Warmer.#mergeToMain] ${sourceBranch} -> ${ontoBranch} threw:`, err);
        base.skipped = [{
          repo_rel_path: ".",
          reason: "parse_error",
          message: formatAtlasError(err),
        }];
        return base;
      }
      const rec = this.#ledger.getBranch(sourceBranch);
      if (rec && rec.status === "active") {
        await this.#emitStage("merge", `marking ${sourceBranch} merged`);
        await this.#ledger.setBranchStatus(sourceBranch, "merged", {
          label: "Warmer.replayMerge.idempotentSetBranchStatus",
        });
      }
    }

    await this.#runScipPhaseIfEnabled(base, "main-merge", { force: true, forceIfMissing: true });

    return await this.#rebuildBranchView({
      payload: { ...payload, out_view_path: payload.out_view_path || mainViewPath(this.#repoRoot) },
      branch: ontoBranch,
      base,
    });
  }

  /**
   * Build a view file for a WI based on current ledger state. The view
   * file is parked at out_view_path (typically the warmed slot). At
   * mount time, the worktree-lifecycle pipeline hook either renames it
   * into the worktree or clones main as a fallback.
   *
   * If the WI branch does not yet exist in the ledger (worktree create
   * hasn't happened), the view targets main at head — the warmed slot
   * is a snapshot of the parent branch that mountForWorktree will
   * re-meta when the fork lands.
   *
   * @param {AtlasWarmJobPayload} payload
   * @param {AtlasWarmJobResult} base
   */
  async #warmWi(payload, base) {
    const outPath =
      payload.out_view_path ||
      (payload.work_item_id != null
        ? warmedViewPath(this.#repoRoot, payload.work_item_id)
        : null);
    if (!outPath) {
      base.skipped = [];
      return base;
    }
    return await withViewWriteLock(outPath, async () => {
      if (fs.existsSync(outPath)) {
        // Already warmed — check whether the existing file is fresh
        // relative to the current ledger head. Stale views get rebuilt;
        // current views short-circuit as a no-op success. This keeps the
        // mount path from serving deltas-old hot-data after `main` has
        // advanced (post-commit reindex landed but warm wasn't refreshed).
        const branchForFreshness = payload.branch || (
          payload.work_item_id != null ? ledgerBranchForWi(payload.work_item_id) : this.#defaultBranch
        );
        const checkBranch = this.#ledger.getBranch(branchForFreshness)
          ? branchForFreshness
          : this.#defaultBranch;
        const headSeqNow = this.#ledger.headSeq(checkBranch);
        /** @type {{ ledger_seq: number, built_at: string, branch: string } | null} */
        let existingMeta = null;
        try {
          await this.#emitStage("view", `checking existing view ${path.basename(outPath)}`);
          const existing = View.mount({ dbPath: outPath });
          try { existingMeta = existing.metaLocal(); }
          finally { existing.close(); }
        } catch {
          // Corrupt / partial file — fall through and rebuild from ledger.
          existingMeta = null;
        }
        const stale = !existingMeta
          || existingMeta.branch !== checkBranch
          || existingMeta.ledger_seq !== headSeqNow
          || !this.#viewMetaMatchesBuildMode(existingMeta);
        if (!stale && existingMeta) {
          base.view_written = outPath;
          base.view_etag = existingMeta.built_at;
          await this.#emitStage("embeddings", `checking embeddings for ${path.basename(outPath)}`);
          await this.#maybeIngestEmbeddings({ viewPath: outPath, base, purpose: "wi" });
          return base;
        }
        // Stale or unreadable — drop the file (plus WAL sidecars) so
        // buildFrom can write a fresh view at the same path.
        for (const sfx of ["", "-wal", "-shm"]) {
          try { fs.unlinkSync(outPath + sfx); }
          catch { /* may not exist, may be locked — buildFrom will surface a clean error */ }
        }
      }
      const branchHint = payload.branch || (
        payload.work_item_id != null ? ledgerBranchForWi(payload.work_item_id) : this.#defaultBranch
      );
      const targetBranch = this.#ledger.getBranch(branchHint) ? branchHint : this.#defaultBranch;
      const atSeq = this.#ledger.headSeq(targetBranch);
      const warmedFiles = Array.isArray(payload.paths) && payload.paths.length > 0
        ? payload.paths.slice(0, 200)
        : null;
      const branchRec = this.#ledger.getBranch(branchHint);
      const branchLocalHeadSeq = branchRec ? this.#ledger.headSeq(branchRec.name) : null;
      const parentCloneSeq = branchRec && branchLocalHeadSeq === 0
        ? branchRec.parent_seq
        : null;
      const main = mainViewPath(this.#repoRoot);
      if (fs.existsSync(main)) {
        const mainProbe = openViewWithMeta(main, View);
        const canCloneMain = mainProbe.ok
          ? viewCanServeBranch({
              meta: mainProbe.meta,
              ledger: this.#ledger,
              branch: targetBranch,
              allowParentBranchAtSeq: parentCloneSeq,
              parentBranch: branchRec?.parent_branch || this.#defaultBranch,
              layerMerge: this.#viewLayerMerge,
            })
          : { ok: false };
        if (mainProbe.ok) {
          try { mainProbe.view.close(); } catch { /* ignore */ }
        }
        if (canCloneMain.ok) {
          await this.#emitStage("view", `cloning main view for ${targetBranch}`);
          this.#builder.cloneView({ sourcePath: main, destPath: outPath });
          if (branchRec) {
            patchViewBranchMeta(outPath, {
              branch: branchRec.name,
              parent_branch: branchRec.parent_branch,
              parent_seq: branchRec.parent_seq,
              ledger_seq: this.#ledger.headSeq(branchRec.name),
            });
          }
          const cloned = View.mount({ dbPath: outPath });
          try {
            const meta = cloned.metaLocal();
            base.view_written = outPath;
            base.view_etag = meta.built_at;
          } finally {
            cloned.close();
          }
          await this.#emitStage("embeddings", `checking embeddings for ${path.basename(outPath)}`);
          await this.#maybeIngestEmbeddings({ viewPath: outPath, base, purpose: "wi" });
          return base;
        }
      }
      await this.#emitStage("view", `building ${targetBranch} view at seq ${atSeq}`);
      const meta = await this.#builder.buildFromAsync({
        ledger: this.#ledger,
        branch: targetBranch,
        atSeq,
        outPath,
        options: {
          ...this.#viewBuildOptions(),
          warmedForFiles: warmedFiles || undefined,
          // Active 3.4 warming — the hint drives the neighborhood prefetch
          // pass inside buildFrom (callers/callees up to depth hops). Skips
          // automatically when paths is empty or contains no canonical paths.
          hint: warmedFiles
            ? { paths: warmedFiles, depth: 2, maxSymbols: 500 }
            : undefined,
        },
      });
      base.view_written = outPath;
      base.view_etag = meta.built_at;
      await this.#emitStage("embeddings", `checking embeddings for ${path.basename(outPath)}`);
      await this.#maybeIngestEmbeddings({ viewPath: outPath, base, purpose: "wi" });
      return base;
    });
  }

  /**
   * Materialize the current branch head into a view file. Main warm jobs
   * update the always-warm main view; incremental jobs can pass touched
   * paths as a prefetch hint so the view metadata records the hot set.
   *
   * @param {{
   *   payload: AtlasWarmJobPayload,
   *   branch: string,
   *   base: AtlasWarmJobResult,
   *   hintPaths?: string[] | null,
   * }} args
   * @returns {Promise<AtlasWarmJobResult>}
   */
  async #rebuildBranchView({ payload, branch, base, hintPaths = null }) {
    const outPath = payload.out_view_path || (branch === this.#defaultBranch ? mainViewPath(this.#repoRoot) : null);
    if (!outPath) return base;
    return await withViewWriteLock(outPath, async () => {
      try {
        await this.#emitStage("view", `building ${branch} view at seq ${this.#ledger.headSeq(branch)}`, {
          percent: 0,
          progress_current: 0,
          progress_total: 1,
        });
        // A full rebuild recreates the view FILE, which would destroy the
        // ML tree-compression snapshot and force a full (provider-priced)
        // re-annotation on the next reseed. Export it first; re-import after
        // the build so the reseed only models deltas.
        const carriedMlSnapshot = this.#treeCompressionMode === "ml"
          ? this.#exportMlCompressionSnapshot(outPath)
          : null;
        // Native retrieval keeps read handles warm between calls. Retire the
        // exact view before replacing this rebuildable cache or Windows will
        // reject the unlink with EBUSY/EPERM on a repeated warm.
        await invalidateStorageCacheNativeAsync(outPath);
        removeSqliteFile(outPath);
        const canonicalHints = Array.isArray(hintPaths)
          ? hintPaths.filter(isCanonicalRepoPath).slice(0, 200)
          : [];
        const viewProgress = (e) => {
          // Map the build's per-phase progress to one overall view/zip %:
          // symbols 0-45%, edges 45-90%, resolve 90-100%. Emitted as
          // stage:"view" so the boot panel's zip bar climbs for real.
          // The tree-derived/compression refresh rides its own stage:"tree"
          // (and its own boot bar) — letting it fall through would snap the
          // zip bar back to the 0% "merging" default.
          if (e?.phase === "tree") {
            this.#emitTreeProgress(e);
            return;
          }
          const frac = (e?.total > 0) ? Math.max(0, Math.min(1, e.current / e.total)) : 0;
          let percent = 0;
          let label = "merging";
          if (e?.phase === "symbols") { percent = frac * 45; label = "merging symbols"; }
          else if (e?.phase === "edges") { percent = 45 + frac * 45; label = "merging edges"; }
          else if (e?.phase === "resolve") { percent = 90 + frac * 10; label = "resolving"; }
          else if (e?.phase === "done") { percent = 100; label = "merged"; }
          this.#emitProgress({
            kind: "line",
            stream: "system",
            stage: "view",
            text: label,
            percent,
            progress_current: e?.current ?? null,
            progress_total: e?.total ?? null,
          });
        };
        const meta = await this.#builder.buildFromAsync({
          ledger: this.#ledger,
          branch,
          atSeq: this.#ledger.headSeq(branch),
          outPath,
          options: {
            ...this.#viewBuildOptions(),
            ...(canonicalHints.length > 0
              ? {
                  warmedForFiles: canonicalHints,
                  hint: { paths: canonicalHints, depth: 2, maxSymbols: 500 },
                }
              : {}),
          },
        }, { onProgress: viewProgress });
        base.view_written = outPath;
        base.view_etag = meta.built_at;
        if (carriedMlSnapshot) this.#importMlCompressionSnapshot(outPath, carriedMlSnapshot);
        await this.#emitStage("embeddings", `checking embeddings for ${path.basename(outPath)}`);
        await this.#maybeIngestEmbeddings({ viewPath: outPath, base, purpose: payload.purpose });
        await this.#maybeReseedTreeCompression({ viewPath: outPath, base, purpose: payload.purpose, triggerEvent: payload?.trigger_event ?? null });
      } catch (err) {
        logAtlasError(`[Warmer.#rebuildBranchView] branch=${branch} threw:`, err);
        base.skipped.push({
          repo_rel_path: ".",
          reason: "parse_error",
          message: `View build failed: ${formatAtlasError(err)}`,
        });
      }
      return base;
    });
  }

  /**
   * Boot-only freshness scan. Uses stored source stat rows as a cheap filter;
   * only files whose size or mtime differs are hashed. Hash mismatches become
   * the incremental warm path list. Hash matches refresh the stat row so the
   * next boot can skip them without hashing.
   *
   * @param {{ branch: string, base: AtlasWarmJobResult }} args
   * @returns {Promise<string[]>}
   */
  async #discoverBootFreshnessPaths({ branch, base }) {
    if (!this.#parser || !this.#ledger.getBranch(branch)) return [];
    const headSeq = this.#ledger.headSeq(branch);
    const snapshot = headSeq > 0 ? this.#ledger.pathSnapshotAt(branch, headSeq) : new Map();
    const sourceStats = typeof /** @type {any} */ (this.#ledger).sourceStatsForBranch === "function"
      ? /** @type {any} */ (this.#ledger).sourceStatsForBranch(branch)
      : new Map();
    const changed = [];
    const changedSet = new Set();
    const seenExisting = new Set();
    const statRefreshes = [];
    const totalByLanguage = new Map();
    const changedByLanguage = new Map();
    let scanned = 0;
    let hashed = 0;
    let statMatched = 0;
    let deleted = 0;
    const languageForPath = (repoRelPath) => languageTagForExtension(path.extname(String(repoRelPath || "")).toLowerCase());
    const rememberChanged = (repoRelPath) => {
      if (!repoRelPath || changedSet.has(repoRelPath)) return;
      changedSet.add(repoRelPath);
      changed.push(repoRelPath);
      const lang = languageForPath(repoRelPath);
      if (lang) changedByLanguage.set(lang, (changedByLanguage.get(lang) || 0) + 1);
    };

    await this.#emitStage("freshness", "checking source freshness", {
      progress_current: 0,
      progress_total: snapshot.size,
      percent: snapshot.size > 0 ? 0 : 100,
    });
    const paths = await walkRepoFilesAsync(this.#repoRoot, (filename, relPath) => {
      const ext = path.extname(filename).toLowerCase();
      if (!ext || !(/** @type {ParserAdapter} */ (this.#parser)).supports(ext)) return false;
      if (isLikelyMinifiedPath(relPath || filename)) return false;
      return true;
    });
    const total = paths.length;
    for (const repoRelPath of paths) {
      const lang = languageForPath(repoRelPath);
      if (!lang) continue;
      totalByLanguage.set(lang, (totalByLanguage.get(lang) || 0) + 1);
    }
    let lastProgressAt = 0;
    const report = async (repoRelPath = "", force = false) => {
      const now = nowMs();
      if (!force && now - lastProgressAt < 200) return;
      lastProgressAt = now;
      await this.#emitStage("freshness", repoRelPath
        ? `checking freshness ${scanned}/${total} ${repoRelPath}`
        : `checking freshness ${scanned}/${total}`, {
        progress_current: scanned,
        progress_total: total,
        percent: total > 0 ? (scanned / total) * 100 : 100,
      });
    };

    for (const repoRelPath of paths) {
      scanned++;
      seenExisting.add(repoRelPath);
      const absPath = path.join(this.#repoRoot, repoRelPath);
      let stat = null;
      try { stat = await fs.promises.stat(absPath); } catch { stat = null; }
      if (!stat?.isFile?.()) {
        if (snapshot.has(repoRelPath)) {
          deleted++;
          rememberChanged(repoRelPath);
        }
        await report(repoRelPath, scanned === 1 || scanned === total);
        continue;
      }
      const expectedHash = snapshot.get(repoRelPath) || "";
      const stored = sourceStats.get(repoRelPath);
      if (expectedHash && sourceStatMatches(stored, stat, expectedHash)) {
        if (!ledgerHasCurrentParsedBlob(this.#ledger, expectedHash, { layerMerge: this.#viewLayerMerge })) {
          rememberChanged(repoRelPath);
          await report(repoRelPath, scanned === 1 || scanned === total);
          continue;
        }
        statMatched++;
        await report(repoRelPath, scanned === 1 || scanned === total);
        continue;
      }
      let fileBytes = null;
      try { fileBytes = await fs.promises.readFile(absPath); } catch {
        rememberChanged(repoRelPath);
        await report(repoRelPath, true);
        continue;
      }
      hashed++;
      const contentHash = sha256Hex(fileBytes);
      if (expectedHash && contentHash === expectedHash) {
        if (ledgerHasCurrentParsedBlob(this.#ledger, contentHash, { layerMerge: this.#viewLayerMerge })) {
          statRefreshes.push(sourceStatRecord({
            branch,
            repo_rel_path: repoRelPath,
            content_hash: contentHash,
            stat,
          }));
        } else {
          rememberChanged(repoRelPath);
        }
      } else {
        rememberChanged(repoRelPath);
      }
      await report(repoRelPath, scanned === 1 || scanned === total);
    }

    for (const repoRelPath of snapshot.keys()) {
      if (seenExisting.has(repoRelPath)) continue;
      const absPath = path.join(this.#repoRoot, repoRelPath);
      let exists = false;
      try { exists = fs.existsSync(absPath); } catch { exists = false; }
      if (!exists) {
        deleted++;
        rememberChanged(repoRelPath);
      }
    }

    if (statRefreshes.length > 0 && typeof /** @type {any} */ (this.#ledger).recordSourceStatsAsync === "function") {
      await /** @type {any} */ (this.#ledger).recordSourceStatsAsync(statRefreshes, {
        label: "Ledger.recordSourceStats.bootFreshness",
      });
    }
    /** @type {any} */ (base).freshness_paths_scanned = scanned;
    /** @type {any} */ (base).freshness_paths_hashed = hashed;
    /** @type {any} */ (base).freshness_stat_matches = statMatched;
    /** @type {any} */ (base).freshness_paths_changed = changed.length;
    /** @type {any} */ (base).freshness_paths_deleted = deleted;
    await this.#emitStage("freshness", `source freshness: ${changed.length} changed, ${hashed} hashed, ${statMatched} stat hits`, {
      progress_current: total,
      progress_total: total,
      percent: 100,
    });
    for (const [language, languageTotal] of totalByLanguage) {
      if (languageTotal <= 0 || (changedByLanguage.get(language) || 0) > 0) continue;
      await this.#emitStage("cached", `source current (${languageTotal} file${languageTotal === 1 ? "" : "s"})`, {
        progress_current: total,
        progress_total: total,
        percent: 100,
        language,
        language_current: languageTotal,
        language_total: languageTotal,
        language_percent: 100,
      });
    }
    return changed;
  }

  /**
   * Reindex a specific list of paths against `branch` (default main).
   * Requires a configured parser; without one, returns skip records.
   *
   * @param {AtlasWarmJobPayload} payload
   * @param {AtlasWarmJobResult} base
   */
  async #warmIncremental(payload, base, {
    buildView = true,
    documentIntake = null,
    stageScipPaths = null,
  } = {}) {
    let paths = Array.isArray(payload?.paths) ? payload.paths : [];
    const branch = payload.branch || this.#defaultBranch;
    if (!this.#ledger.getBranch(branch)) {
      base.skipped = paths.map((p) => ({
        repo_rel_path: String(p),
        reason: "unsupported_lang",
        message: `Ledger branch '${branch}' does not exist`,
      }));
      return base;
    }
    if (!this.#parser) {
      base.skipped = paths.map((p) => ({
        repo_rel_path: String(p),
        reason: "unsupported_lang",
        message: "Parser adapter not configured",
      }));
      return base;
    }
    // Boot warms and truncated-hint warms both need the freshness scan: the
    // former has no hints at all, the latter deliberately dropped an
    // over-cap hint list rather than index a silent subset of it.
    if (paths.length === 0
      && (String(payload?.trigger_event || "") === "boot" || payload?.paths_truncated === true)) {
      paths = await this.#discoverBootFreshnessPaths({ branch, base });
    }
    paths = orderedUniquePaths(paths);
    base.paths_considered = paths.length;
    await this.#indexPaths({ paths, branch, base, documentIntake, stageScipPaths });
    if (!buildView) {
      // Caller (handleWarmJob) will build the view once after SCIP ingest.
      // Stash the hint paths so that deferred build can scope its work.
      /** @type {any} */ (base)._incrementalHintPaths = paths;
      return base;
    }
    return await this.#updateBranchViewIncremental({ payload, branch, base, hintPaths: paths });
  }

  /**
   * Apply only the new ledger entries to the existing view in place. Falls
   * back to a full rebuild when the view doesn't exist, is for the wrong
   * branch, or any step throws — full rebuild is always safe.
   *
   * @param {{
   *   payload: AtlasWarmJobPayload,
   *   branch: string,
   *   base: AtlasWarmJobResult,
   *   hintPaths?: string[] | null,
   * }} args
   * @returns {Promise<AtlasWarmJobResult>}
   */
  async #updateBranchViewIncremental({ payload, branch, base, hintPaths = null }) {
    const outPath = payload.out_view_path || (branch === this.#defaultBranch ? mainViewPath(this.#repoRoot) : null);
    if (!outPath) return base;
    if (!fs.existsSync(outPath)) {
      // No existing view — caller still wants a view built, so fall through
      // to the full rebuild path. main-incremental on a cold cache pays the
      // full cost once; subsequent incrementals get the fast path.
      return this.#rebuildBranchView({ payload, branch, base, hintPaths });
    }
    const incremental = await withViewWriteLock(outPath, async () => {
      /** @type {View | null} */
      let view = null;
      try {
        await this.#emitStage("view", `updating ${branch} view ${path.basename(outPath)}`, {
          percent: 0,
          progress_current: 0,
          progress_total: 1,
        });
        view = View.mount({ dbPath: outPath, mode: "readwrite" });
        const meta = view.metaLocal();
        if (meta.branch !== branch) {
          // Branch swap — incremental is unsafe across branches; do a full rebuild.
          try { view.close(); } catch { /* ignore */ }
          view = null;
          return { fallback: true, result: base };
        }
        if (!this.#viewMetaMatchesBuildMode(meta)) {
          try { view.close(); } catch { /* ignore */ }
          view = null;
          return { fallback: true, result: base };
        }
        if (/** @type {any} */ (base)._forceViewRebuild === true) {
          try { view.close(); } catch { /* ignore */ }
          view = null;
          return { fallback: true, result: base };
        }
        const previousLedgerSeq = Number.isInteger(meta.ledger_seq) ? meta.ledger_seq : 0;
        const entries = this.#ledger.tail(branch, previousLedgerSeq);
        /** @type {EmbeddingIngestScope | null} */
        let embeddingScope = null;
        if (entries.length === 0) {
          base.view_written = outPath;
          base.view_etag = meta.built_at;
          embeddingScope = await this.#embeddingScopeForEntries({
            view,
            entries,
            previousLedgerSeq,
            nextLedgerSeq: previousLedgerSeq,
          });
        } else {
          await this.#emitStage("view", `applying ${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"}`, {
            percent: 0,
            progress_current: 0,
            progress_total: entries.length,
          });
          const updated = await this.#builder.incrementalApplyAsync({
            view,
            ledger: this.#ledger,
            entries,
            options: { layerMerge: this.#viewLayerMerge },
          }, {
            onProgress: (e) => {
              if (e?.phase === "tree") {
                this.#emitTreeProgress(e);
                return;
              }
              const frac = (e?.total > 0) ? Math.max(0, Math.min(1, e.current / e.total)) : 0;
              let percent = 0;
              let label = "applying entries";
              if (e?.phase === "entries") { percent = frac * 90; label = "applying entries"; }
              else if (e?.phase === "resolve") { percent = 90 + frac * 10; label = "resolving"; }
              else if (e?.phase === "done") { percent = 100; label = "merged"; }
              this.#emitProgress({
                kind: "line",
                stream: "system",
                stage: "view",
                text: label,
                percent,
                progress_current: e?.current ?? null,
                progress_total: e?.total ?? null,
              });
            },
          });
          const targetSeq = entries[entries.length - 1]?.seq ?? meta.ledger_seq;
          if (updated.ledger_seq !== targetSeq) {
            try { view.close(); } catch { /* ignore */ }
            view = null;
            return { fallback: true, result: base };
          }
          base.view_written = outPath;
          base.view_etag = updated.built_at;
          embeddingScope = await this.#embeddingScopeForEntries({
            view,
            entries,
            previousLedgerSeq,
            nextLedgerSeq: updated.ledger_seq,
          });
        }
        try { view.close(); } catch { /* ignore */ }
        view = null;
        await this.#emitStage("view", "merged", {
          percent: 100,
          progress_current: 1,
          progress_total: 1,
        });
        await this.#emitStage("embeddings", `checking embeddings for ${path.basename(outPath)}`);
        await this.#maybeIngestEmbeddings({ viewPath: outPath, base, purpose: payload.purpose, embeddingScope });
        await this.#maybeReseedTreeCompression({ viewPath: outPath, base, purpose: payload.purpose, triggerEvent: payload?.trigger_event ?? null });
        return { fallback: false, result: base };
      } catch (err) {
        logAtlasError(`[Warmer.#updateBranchViewIncremental] branch=${branch} fell back to full rebuild:`, err);
        try { if (view) view.close(); } catch { /* ignore */ }
        return { fallback: true, result: base };
      }
    });
    if (incremental.fallback) {
      return this.#rebuildBranchView({ payload, branch, base, hintPaths });
    }
    return incremental.result;
  }

  /**
   * Walk the repo root and (re)index every supported file. Same parser
   * dependency as #warmIncremental. Skips common vendored / generated
   * directories and respects `MAX_FULL_WARM_PATHS` as a hard upper bound
   * so a runaway repo doesn't blow the per-job runtime budget.
   *
   * @param {AtlasWarmJobPayload} payload
   * @param {AtlasWarmJobResult} base
   */
  async #warmFull(payload, base, {
    buildView = true,
    documentIntake = null,
    stageScipPaths = null,
  } = {}) {
    base.skipped = [];
    base.paths_considered = 0;
    const branch = payload.branch || this.#defaultBranch;
    if (!this.#parser) {
      base.skipped = [{
        repo_rel_path: ".",
        reason: "unsupported_lang",
        message: "Parser adapter not configured",
      }];
      return base;
    }
    if (!this.#ledger.getBranch(branch)) {
      base.skipped = [{
        repo_rel_path: ".",
        reason: "unsupported_lang",
        message: `Ledger branch '${branch}' does not exist`,
      }];
      return base;
    }
    await this.#emitStage("walking", `scanning repository for ${branch}`);
    const walkedPaths = await walkRepoFilesAsync(this.#repoRoot, (filename, relPath) => {
      const ext = path.extname(filename).toLowerCase();
      if (!ext || !(/** @type {ParserAdapter} */ (this.#parser)).supports(ext)) return false;
      // Skip well-known minified/bundled paths so we never even open them.
      // Catches *.min.js, *-min.js, *.bundle.js, *.bundle.<hash>.js etc.
      if (isLikelyMinifiedPath(relPath || filename)) return false;
      return true;
    }, { maxPaths: MAX_FULL_WARM_PATHS });
    let paths = walkedPaths;
    const truncated = walkedPaths.length >= MAX_FULL_WARM_PATHS;
    let removedSnapshotPaths = [];
    if (truncated) {
      base.truncated = true;
      base.truncation_reason = `Full warm stopped at MAX_FULL_WARM_PATHS=${MAX_FULL_WARM_PATHS}`;
    } else {
      const headSeq = this.#ledger.headSeq(branch);
      const snapshot = headSeq > 0 ? this.#ledger.pathSnapshotAt(branch, headSeq) : new Map();
      const walkedSet = new Set(walkedPaths);
      removedSnapshotPaths = [...snapshot.keys()]
        .filter((repoRelPath) => !walkedSet.has(repoRelPath))
        .sort();
      if (removedSnapshotPaths.length > 0) {
        paths = walkedPaths.concat(removedSnapshotPaths);
        /** @type {any} */ (base).fileset_paths_removed = removedSnapshotPaths.length;
        await this.#emitStage("walking", `reconciling ${removedSnapshotPaths.length} removed indexed file${removedSnapshotPaths.length === 1 ? "" : "s"}`, {
          progress_current: walkedPaths.length,
          progress_total: paths.length,
          percent: paths.length > 0 ? (walkedPaths.length / paths.length) * 100 : 100,
        });
      }
    }
    paths = orderedUniquePaths(paths);
    base.paths_considered = paths.length;
    const removedSuffix = removedSnapshotPaths.length > 0
      ? `, ${removedSnapshotPaths.length} removed indexed file${removedSnapshotPaths.length === 1 ? "" : "s"}`
      : "";
    await this.#emitStage("walking", `found ${walkedPaths.length} supported file${walkedPaths.length === 1 ? "" : "s"}${removedSuffix}`, {
      progress_current: 0,
      progress_total: paths.length,
      percent: paths.length > 0 ? 0 : 100,
    });
    await this.#indexPaths({ paths, branch, base, documentIntake, stageScipPaths });
    if (!buildView) return base;
    return await this.#rebuildBranchView({ payload, branch, base });
  }

  /**
   * Shared per-path indexing pipeline used by both #warmIncremental and
   * #warmFull. For each repo-relative path:
   *
   *   - Validate canonical form. Non-canonical → skip(unsupported_lang).
   *   - If the file is missing on disk and the branch already had it,
   *     append a `remove` delta. If the file is missing AND the branch
   *     never had it, silently no-op.
   *   - Else require the parser to support the extension. Unsupported
   *     → skip(unsupported_lang).
   *   - parser.parseFile → ParseResult. On throw → skip(parse_error).
   *   - Compare to the branch's current head for this path. Same hash
   *     → no-op (don't touch counters).
   *   - Idempotent blob ingest (reuse when hash already present).
   *   - Append `add` or `modify` delta. Snapshot is mutated locally so a
   *     batch that touches the same path twice still produces the right
   *     parent_seq lineage on the second touch.
   *
   * Errors per-file do not abort the batch — failures are surfaced in
   * `base.skipped` so operators can see which files couldn't be indexed.
   *
   * @param {{ paths: string[], branch: string, base: AtlasWarmJobResult, documentIntake?: OrderedDocumentIntake | null, stageScipPaths?: ((paths: string[]) => Promise<unknown>) | null }} args
   */
  async #indexPaths({ paths, branch, base, documentIntake = null, stageScipPaths = null }) {
    if (!this.#parser) return;
    await this.#emitStage("snapshot", `loading ${branch} path snapshot`);
    const headSeq = this.#ledger.headSeq(branch);
    const snapshot = headSeq > 0
      ? this.#ledger.pathSnapshotAt(branch, headSeq)
      : new Map();
    documentIntake?.registerPaths(paths);
    const scipWork = typeof stageScipPaths === "function"
      ? Promise.resolve().then(() => stageScipPaths(paths))
      : null;
    const total = paths.length;
    // Per-language totals (computed up front from path extensions) so each
    // progress event can carry { language, current_for_lang, total_for_lang }
    // and the display can render one row per language.
    const totalByLanguage = new Map();
    try {
    for (const rawPath of paths) {
      const ext = path.extname(String(rawPath || "")).toLowerCase();
      const lang = languageTagForExtension(ext);
      if (!lang) continue;
      totalByLanguage.set(lang, (totalByLanguage.get(lang) || 0) + 1);
    }
    const currentByLanguage = new Map();
    let considered = 0;
    let lastProgressAt = 0;
    let lastYieldAt = nowMs();
    const reportIndexProgress = async (repoRelPath = "", {
      force = false,
      stage = "indexing",
      text = null,
      current = considered,
      language = null,
    } = {}) => {
      const at = nowMs();
      const shouldReport = total > 0 && (
        force
        || considered === 0
        || considered === total
        || at - lastProgressAt >= 200
      );
      if (shouldReport) {
        lastProgressAt = at;
        const suffix = repoRelPath ? ` (${repoRelPath})` : "";
        const progressCurrent = Math.max(0, Math.min(total, Number(current) || 0));
        const langTotal = language ? (totalByLanguage.get(language) || 0) : null;
        const langCurrent = language ? (currentByLanguage.get(language) || 0) : null;
        this.#emitProgress({
          kind: "line",
          stream: "system",
          stage,
          text: text || `${considered}/${total} files checked${suffix}`,
          progress_current: progressCurrent,
          progress_total: total,
          percent: total > 0 ? (progressCurrent / total) * 100 : 100,
          language,
          language_current: langCurrent,
          language_total: langTotal,
          language_percent: langTotal && langTotal > 0
            ? Math.max(0, Math.min(100, (langCurrent / langTotal) * 100))
            : null,
        });
      }
      if (force || considered % 25 === 0 || at - lastYieldAt >= 50) {
        lastYieldAt = nowMs();
        await this.#yieldForProgress();
      }
    };
    await reportIndexProgress("", { force: true });
    const recordPathSourceStat = async (repoRelPath, contentHash, stat) => {
      if (!stat || typeof /** @type {any} */ (this.#ledger).recordSourceStatAsync !== "function") return;
      await /** @type {any} */ (this.#ledger).recordSourceStatAsync(sourceStatRecord({
        branch,
        repo_rel_path: repoRelPath,
        content_hash: contentHash,
        stat,
      }), { label: "Ledger.recordSourceStat.indexPath" });
    };
    const deletePathSourceStat = async (repoRelPath) => {
      if (typeof /** @type {any} */ (this.#ledger).deleteSourceStatAsync !== "function") return;
      await /** @type {any} */ (this.#ledger).deleteSourceStatAsync({
        branch,
        repo_rel_path: repoRelPath,
      }, { label: "Ledger.deleteSourceStat.indexPath" });
    };

    for (const rawPath of paths) {
      const repo_rel_path = String(rawPath || "");
      considered++;
      const ordinal = considered;
      const pathLanguage = languageTagForExtension(path.extname(repo_rel_path).toLowerCase());
      let documentPublished = false;
      if (pathLanguage) {
        currentByLanguage.set(pathLanguage, (currentByLanguage.get(pathLanguage) || 0) + 1);
      }
      try {
        await documentIntake?.waitForReadAhead(repo_rel_path);
        await reportIndexProgress(repo_rel_path, {
          force: true,
          stage: "checking",
          current: ordinal,
          text: `checking ${ordinal}/${total} ${repo_rel_path}`,
          language: pathLanguage,
        });
        if (!isCanonicalRepoPath(repo_rel_path)) {
          base.skipped.push({
            repo_rel_path,
            reason: "unsupported_lang",
            message: "Non-canonical repo path; expected forward-slash repo-relative form",
          });
          continue;
        }

        const absPath = path.join(this.#repoRoot, repo_rel_path);
        let onDiskExists = false;
        try { onDiskExists = fs.existsSync(absPath); }
        catch { onDiskExists = false; }

        if (!onDiskExists) {
          await reportIndexProgress(repo_rel_path, {
            force: true,
            stage: "recording delta",
            current: ordinal,
            text: `recording missing file ${ordinal}/${total} ${repo_rel_path}`,
            language: pathLanguage,
          });
          const before = snapshot.get(repo_rel_path);
          if (before) {
            recordStaleEmbeddingHash(base, before);
            await this.#ledger.append({
              branch,
              op: "remove",
              repo_rel_path,
              before_content_hash: before,
              after_content_hash: null,
            });
            await deletePathSourceStat(repo_rel_path);
            base.ledger_entries_appended++;
            snapshot.delete(repo_rel_path);
          }
          continue;
        }

        const ext = path.extname(repo_rel_path).toLowerCase();
        if (!ext || !this.#parser.supports(ext)) {
          base.skipped.push({
            repo_rel_path,
            reason: "unsupported_lang",
            message: `Unsupported extension '${ext || "(none)"}'`,
          });
          continue;
        }

        // Path-glob skip catches *.min.js / *.bundle.js without opening the
        // file. Path globs miss non-suffix-conventional bundles like
        // hls-DixMeGmu.js — fall back to a content-shape sample.
        if (isLikelyMinifiedPath(repo_rel_path)) {
          base.skipped.push({
            repo_rel_path,
            reason: "minified_skip",
            message: "Path matches minified/bundled pattern",
          });
          continue;
        }
        /** @type {Buffer | null} */
        let fileBytes = null;
        let fileStat = null;
        /** @type {string | null} */
        let contentHash = null;
        try {
          await reportIndexProgress(repo_rel_path, {
            force: true,
            stage: "sampling",
            current: ordinal,
            text: `sampling ${ordinal}/${total} ${repo_rel_path}`,
            language: pathLanguage,
          });
          fileStat = await fs.promises.stat(absPath);
          if (isOversizedForParsing(fileStat.size)) {
            base.skipped.push({
              repo_rel_path,
              reason: "size_exceeded",
              message: `File is ${fileStat.size} bytes; max parse size is ${MAX_PARSE_FILE_BYTES} bytes`,
            });
            continue;
          }
          fileBytes = await fs.promises.readFile(absPath);
          contentHash = sha256Hex(fileBytes);
          const sample = fileBytes.subarray(0, Math.min(fileBytes.length, MINIFIED_SAMPLE_BYTES));
          if (sample.length > 0) {
            const inspection = inspectSampleForMinified(sample);
            if (inspection.minified) {
              base.skipped.push({
                repo_rel_path,
                reason: "minified_skip",
                message: `Content looks minified (maxLine=${Math.round(inspection.maxLineLen)} meanLine=${Math.round(inspection.meanLineLen)})`,
              });
              continue;
            }
          }
        } catch {
          // Read failure isn't fatal; let the parser have its own attempt
          // and surface the error from there.
        }

        const beforeHash = snapshot.get(repo_rel_path) || null;
        const currentParsedBlob = contentHash
          && beforeHash === contentHash
          && ledgerHasCurrentParsedBlob(this.#ledger, contentHash, { layerMerge: this.#viewLayerMerge });
        const mergeExistingScipRows = !this.#viewLayerMerge
          && currentParsedBlob
          && shouldMergeTreeSitterRowsForScipBlob({
            ledger: this.#ledger,
            contentHash,
            repoRelPath: repo_rel_path,
          });
        if (currentParsedBlob && !mergeExistingScipRows) {
          // Same bytes and current parsed rows already on this branch.
          await recordPathSourceStat(repo_rel_path, contentHash, fileStat);
          await documentIntake?.markTreeSitter({ repo_rel_path, content_hash: contentHash });
          documentPublished = true;
          continue;
        }

        /** @type {ParseResult | null} */
        let parsed = null;
        try {
          await reportIndexProgress(repo_rel_path, {
            force: true,
            stage: "parsing",
            current: ordinal,
            text: `parsing ${ordinal}/${total} ${repo_rel_path}`,
            language: pathLanguage,
          });
          parsed = fileBytes && typeof /** @type {any} */ (this.#parser).parseBuffer === "function"
            ? await /** @type {any} */ (this.#parser).parseBuffer({ bytes: fileBytes, repo_rel_path })
            : await this.#parser.parseFile({ absPath, repoRoot: this.#repoRoot });
        } catch (err) {
          logAtlasError(`[Warmer.#indexPaths] parse failed for ${repo_rel_path}:`, err);
          base.skipped.push({
            repo_rel_path,
            reason: "parse_error",
            message: formatAtlasError(err),
          });
          if (!this.#viewLayerMerge || !contentHash || !pathLanguage) continue;
          parsed = {
            repo_rel_path,
            content_hash: contentHash,
            lang: pathLanguage,
            symbols: [],
            edges: [],
            hasError: false,
          };
          /** @type {any} */ (base).treesitter_empty_layers = Number(/** @type {any} */ (base).treesitter_empty_layers || 0) + 1;
          const emptyLayerPaths = Array.isArray(/** @type {any} */ (base).treesitter_empty_layer_paths)
            ? /** @type {any} */ (base).treesitter_empty_layer_paths
            : [];
          emptyLayerPaths.push(repo_rel_path);
          /** @type {any} */ (base).treesitter_empty_layer_paths = emptyLayerPaths;
        }
        if (parsed.hasError) {
          const partialSymbolCount = Array.isArray(parsed.symbols) ? parsed.symbols.length : 0;
          const partialEdgeCount = Array.isArray(parsed.edges) ? parsed.edges.length : 0;
          const retainPartial = partialSymbolCount > 0;
          const disposition = retainPartial
            ? `retained ${partialSymbolCount} symbols and ${partialEdgeCount} edges from valid syntax regions`
            : "partial extraction contained no symbols and was discarded";
          const err = new Error(`tree-sitter parse error for ${repo_rel_path}; ${disposition}`);
          logAtlasError(`[Warmer.#indexPaths] recovered parse was partial for ${repo_rel_path}:`, err);
          base.skipped.push({
            repo_rel_path,
            reason: "parse_error",
            message: formatAtlasError(err),
          });
          if (retainPartial) {
            parsed = { ...parsed, hasError: false };
            /** @type {any} */ (base).treesitter_partial_layers = Number(/** @type {any} */ (base).treesitter_partial_layers || 0) + 1;
            const partialLayerPaths = Array.isArray(/** @type {any} */ (base).treesitter_partial_layer_paths)
              ? /** @type {any} */ (base).treesitter_partial_layer_paths
              : [];
            partialLayerPaths.push(repo_rel_path);
            /** @type {any} */ (base).treesitter_partial_layer_paths = partialLayerPaths;
          } else {
          if (!this.#viewLayerMerge || !contentHash || !pathLanguage) continue;
          parsed = {
            repo_rel_path,
            content_hash: contentHash,
            lang: pathLanguage,
            symbols: [],
            edges: [],
            hasError: false,
          };
          /** @type {any} */ (base).treesitter_empty_layers = Number(/** @type {any} */ (base).treesitter_empty_layers || 0) + 1;
          const emptyLayerPaths = Array.isArray(/** @type {any} */ (base).treesitter_empty_layer_paths)
            ? /** @type {any} */ (base).treesitter_empty_layer_paths
            : [];
          emptyLayerPaths.push(repo_rel_path);
          /** @type {any} */ (base).treesitter_empty_layer_paths = emptyLayerPaths;
          }
        }

        let parsedByteSize = fileBytes ? fileBytes.length : 0;
        if (!parsedByteSize) {
          try { parsedByteSize = fs.statSync(absPath).size; }
          catch { parsedByteSize = 0; }
        }

        const before = beforeHash;
        if (this.#viewLayerMerge) {
          // Order-independent path: tree-sitter writes its OWN layer; the view
          // merge (buildFrom layerMerge) combines it with any SCIP layer.
          await this.#ledger.ingestBlobLayer({
            content_hash: parsed.content_hash,
            lang: parsed.lang,
            byte_size: parsedByteSize,
            symbols: parsed.symbols,
            edges: parsed.edges,
            source: "treesitter",
          });
          base.blobs_ingested++;
        } else {
        if (before === parsed.content_hash && ledgerHasCurrentParsedBlob(this.#ledger, parsed.content_hash, { layerMerge: this.#viewLayerMerge })) {
          if (mergeExistingScipRows && typeof /** @type {any} */ (this.#ledger).mergeBlobParseRows === "function") {
            await reportIndexProgress(repo_rel_path, {
              force: true,
              stage: "writing ledger",
              current: ordinal,
              text: `merging parser rows ${ordinal}/${total} ${repo_rel_path}`,
              language: pathLanguage,
            });
            const merged = await /** @type {any} */ (this.#ledger).mergeBlobParseRows({
              ...parsed,
              byte_size: parsedByteSize,
            }, {
              label: "Warmer.mergeBlobParseRows",
            });
            if (Number(merged?.inserted_symbols || 0) > 0 || Number(merged?.inserted_edges || 0) > 0) {
              /** @type {any} */ (base).parser_rows_merged = Number(/** @type {any} */ (base).parser_rows_merged || 0)
                + Number(merged?.inserted_symbols || 0);
              /** @type {any} */ (base)._forceViewRebuild = true;
              base.blobs_reused++;
              base.paths_indexed++;
            }
          }
          // Same bytes already on this branch with current parsed rows.
          await recordPathSourceStat(repo_rel_path, parsed.content_hash, fileStat);
          continue;
        }

        if (ledgerHasCurrentParsedBlob(this.#ledger, parsed.content_hash, { layerMerge: this.#viewLayerMerge })) {
          await reportIndexProgress(repo_rel_path, {
            force: true,
            stage: "writing ledger",
            current: ordinal,
            text: `reusing blob ${ordinal}/${total} ${repo_rel_path}`,
            language: pathLanguage,
          });
          base.blobs_reused++;
        } else {
          await reportIndexProgress(repo_rel_path, {
            force: true,
            stage: "writing ledger",
            current: ordinal,
            text: `ingesting blob ${ordinal}/${total} ${repo_rel_path}`,
            language: pathLanguage,
          });
          await this.#ledger.ingestBlob({
            content_hash: parsed.content_hash,
            lang: parsed.lang,
            byte_size: parsedByteSize,
            symbols: parsed.symbols,
            edges: parsed.edges,
          });
          base.blobs_ingested++;
        }
        }

        if (before === parsed.content_hash) {
          if (this.#viewLayerMerge) /** @type {any} */ (base)._forceViewRebuild = true;
          await recordPathSourceStat(repo_rel_path, parsed.content_hash, fileStat);
          await documentIntake?.markTreeSitter({ repo_rel_path, content_hash: parsed.content_hash });
          documentPublished = true;
          continue;
        }

        await reportIndexProgress(repo_rel_path, {
          force: true,
          stage: "recording delta",
          current: ordinal,
          text: `recording delta ${ordinal}/${total} ${repo_rel_path}`,
          language: pathLanguage,
        });
        if (before) recordStaleEmbeddingHash(base, before);
        await this.#ledger.append({
          branch,
          op: before ? "modify" : "add",
          repo_rel_path,
          before_content_hash: before,
          after_content_hash: parsed.content_hash,
        });
        await recordPathSourceStat(repo_rel_path, parsed.content_hash, fileStat);
        base.ledger_entries_appended++;
        base.paths_indexed++;
        snapshot.set(repo_rel_path, parsed.content_hash);
        await documentIntake?.markTreeSitter({ repo_rel_path, content_hash: parsed.content_hash });
        documentPublished = true;
      } finally {
        if (!documentPublished) documentIntake?.skip(repo_rel_path);
        await reportIndexProgress(repo_rel_path, { force: considered === total, language: pathLanguage });
      }
    }
    } finally {
      documentIntake?.finishTreeSitter();
      if (scipWork) await scipWork;
    }
  }

  /**
   * Build the symbol subset that changed between two ledger positions. The
   * caller has already applied the entries to `view`, so removed paths simply
   * produce no symbols here and are handled by stale-hash pruning.
   *
   * @param {{ view: View, entries: any[], previousLedgerSeq: number, nextLedgerSeq: number }} args
   * @returns {Promise<EmbeddingIngestScope>}
   */
  async #embeddingScopeForEntries({ view, entries, previousLedgerSeq, nextLedgerSeq }) {
    /** @type {Map<string, string | null>} */
    const latestAfterByPath = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const repoRelPath = String(entry?.repo_rel_path || "").trim();
      if (!isCanonicalRepoPath(repoRelPath)) continue;
      latestAfterByPath.set(repoRelPath, entry?.after_content_hash ? String(entry.after_content_hash) : null);
    }

    /** @type {ViewSymbol[]} */
    const onlySymbols = [];
    const seen = new Set();
    for (const [repoRelPath, contentHash] of latestAfterByPath.entries()) {
      if (!contentHash) continue;
      const symbols = (await view.query.symbolsInFile(repoRelPath))
        .filter((symbol) => symbol.content_hash === contentHash);
      for (const symbol of symbols) {
        const key = `${symbol.content_hash}\0${symbol.local_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        onlySymbols.push(symbol);
      }
    }
    return {
      kind: "incremental",
      previousLedgerSeq,
      nextLedgerSeq,
      touchedPaths: [...latestAfterByPath.keys()],
      onlySymbols,
    };
  }

  /**
   * Open the resident Jina/vector pair before parsing and attach it to an
   * ordered A+B document stream. The ordinary post-view ingest remains the
   * reconciliation/rollback path; this ride-along path only shortens intake.
   *
   * @param {AtlasWarmJobResult} base
   */
  #startDocumentEmbeddingIntake(base) {
    if (!this.#viewLayerMerge || !this.#parser) return null;
    const resources = openEmbeddingResources({
      repoRoot: this.#repoRoot,
      config: this.#runtimeConfig,
    });
    if (!resources.enabled || !resources.encoder || !resources.index) {
      try { resources.close?.(); } catch { /* disabled resources are inert */ }
      return null;
    }
    const documentWindow = positiveIntOrDefault(
      /** @type {any} */ (this.#runtimeConfig).atlasEmbeddingDocumentWindow
        ?? /** @type {any} */ (this.#runtimeConfig).atlas_embedding_document_window,
      8,
    );
    const documents = new OrderedDocumentIntake({ readAhead: documentWindow });
    const encoder = /** @type {any} */ (resources.encoder);
    const index = /** @type {any} */ (resources.index);
    const supportsStructuredSymbols = typeof encoder.encodeSymbols === "function";
    recordIntakeTelemetry(base, "onnx.queue_started", { document_window: documentWindow });
    const runner = /** @type {any} */ (startOnnxRefresh({
      mode: "changed",
      modelId: String(encoder.model || encoder.modelId || "jina"),
      modelVersion: String(encoder.model_version || encoder.modelVersion || "unknown"),
      batchSize: encoder.batchSize || undefined,
      documentWindow,
      wait: false,
      signal: this.#signal || undefined,
      documents,
      getDocumentTotal: () => documents.totalDocuments,
      mergeDocument: async (document) => {
        const repoRelPath = String(document.repo_rel_path || document.document_id || "");
        const contentHash = String(document.content_hash || "");
        const lang = languageTagForExtension(path.extname(repoRelPath).toLowerCase());
        const merged = mergeLayerRows(this.#ledger._unsafeDb(), contentHash, lang);
        const symbols = merged.symbols
          .filter((symbol) => hasLanguageSemantics(symbol?.lang))
          .map((symbol) => streamEmbeddingSymbol({
            ...symbol,
            repo_rel_path: repoRelPath,
          }));
        return await symbolsMissingFromEmbeddingIndex(index, symbols);
      },
      ...(supportsStructuredSymbols ? {} : {
        buildSymbolText: (symbol) => String(encoder.buildSymbolText(symbol) || ""),
      }),
      embedSymbols: async (symbols, signal, onProgress) => {
        const startedAt = nowMs();
        recordIntakeTelemetry(base, "onnx.batch_started", { symbols: symbols.length });
        const onNativeProgress = (event) => {
          recordIntakeTelemetry(base, String(event?.kind || "ml.embedding.progress"), {
            phase: event?.phase ?? null,
            current: event?.current ?? null,
            total: event?.total ?? null,
            batch_current: event?.batchCurrent ?? null,
            batch_total: event?.batchTotal ?? null,
            batch_items: event?.batchItems ?? null,
            native_elapsed_ms: event?.elapsedMs ?? null,
          });
          this.#emitProgress({ ...event, stage: "embeddings", stream: "system" });
        };
        const vectors = supportsStructuredSymbols
          ? await encoder.encodeSymbols(symbols, signal, onNativeProgress)
          : typeof encoder.encodeDocuments === "function"
            ? await encoder.encodeDocuments(symbols.map((symbol) => String(symbol.text || "")), signal, onNativeProgress)
            : await encoder.encode(symbols.map((symbol) => String(symbol.text || "")), signal, onNativeProgress);
        const normalized = Array.isArray(vectors)
          ? vectors.map((vector, index) => ({ symbol_key: symbols[index].symbol_key, vector }))
          : vectors;
        recordIntakeTelemetry(base, "onnx.batch_completed", {
          symbols: symbols.length,
          duration_ms: nowMs() - startedAt,
        });
        return normalized;
      },
      commitBatch: async (rows) => {
        await index.add(rows.map((row) => embeddingIndexRow(row)));
      },
      ...(typeof index.setEmbeddingWatermark === "function" ? {
        persistWatermark: (watermark) => index.setEmbeddingWatermark(
          `stream:${sha256Hex(path.resolve(this.#repoRoot))}`,
          { ...watermark, updated_at: new Date().toISOString() },
        ),
      } : {}),
      onDocumentProcessed: (document) => documents.markProcessed(document),
      onEvent: (event) => {
        recordIntakeTelemetry(base, String(event?.kind || "onnx.event"), {
          current: event?.current ?? null,
          processed_documents: event?.processedDocuments ?? null,
          duplicate_symbols: event?.duplicateSymbols ?? null,
          total_duplicate_symbols: event?.totalDuplicateSymbols ?? null,
          unique_symbols: event?.uniqueSymbols ?? null,
        });
        this.#emitProgress({ ...event, stage: "embeddings", stream: "system" });
      },
    }));
    base.embeddings_streaming = true;
    /** @type {any} */ (base).embeddings_document_window = documentWindow;
    return { documents, resources, runner, closed: false };
  }

  /**
   * @param {{ documents: OrderedDocumentIntake, resources: any, runner: any, closed: boolean } | null} intake
   * @param {AtlasWarmJobResult} base
   */
  async #finishDocumentEmbeddingIntake(intake, base) {
    if (!intake || intake.closed) return;
    intake.documents.finishTreeSitter();
    intake.documents.finishScip();
    try {
      const report = await intake.runner.done;
      await intake.documents.done;
      /** @type {any} */ (base).embeddings_streamed_documents = Number(report?.processedDocuments || 0);
      /** @type {any} */ (base).embeddings_streamed_symbols = Number(report?.indexedSymbols || 0);
      recordIntakeTelemetry(base, "onnx.queue_completed", {
        documents: Number(report?.processedDocuments || 0),
        symbols: Number(report?.indexedSymbols || 0),
        duplicate_symbols: Number(report?.duplicateSymbols || 0),
      });
    } catch (err) {
      /** @type {any} */ (base).embeddings_streaming_error = formatAtlasError(err);
      recordIntakeTelemetry(base, "onnx.queue_failed", {
        error: formatAtlasError(err),
      });
      intake.documents.abort(err);
      logAtlasError("[Warmer.#finishDocumentEmbeddingIntake] streaming ingest failed:", err);
    } finally {
      intake.closed = true;
      try { await intake.resources.close(); } catch { /* final bulk pass can reopen/reconcile */ }
    }
  }

  async #abortDocumentEmbeddingIntake(intake, error) {
    if (!intake || intake.closed) return;
    intake.closed = true;
    intake.documents.abort(error);
    try { await intake.runner.done; } catch { /* original warm error wins */ }
    try { await intake.resources.close(); } catch { /* final recovery reopens */ }
  }

  /**
   * @param {{ viewPath: string, base: AtlasWarmJobResult, purpose: AtlasWarmPurpose, embeddingScope?: EmbeddingIngestScope | null }} args
   * @returns {Promise<void>}
   */
  async #maybeIngestEmbeddings({ viewPath, base, purpose, embeddingScope = null }) {
    const rawMode = String(
      /** @type {any} */ (this.#runtimeConfig)?.wiEmbeddings
        || /** @type {any} */ (this.#runtimeConfig)?.atlasWiEmbeddings
        || /** @type {any} */ (this.#runtimeConfig)?.atlas_wi_embeddings
        || "on_demand",
    ).trim().toLowerCase();
    const mode = rawMode === "off" || rawMode === "on" || rawMode === "on_demand" ? rawMode : "on_demand";
    const isMainPurpose = purpose === "main-incremental"
      || purpose === "main-full"
      || purpose === "main-merge";

    if (isMainPurpose || (purpose === "wi" && mode === "on")) {
      if (this.#deferEmbeddings) {
        // Deferred mode (conductor host): the encode-heavy embeddings pass is
        // queued and run by flushDeferredEmbeddings() AFTER the warm releases
        // the serial write queue, so merges and queued warms aren't held
        // behind vector encoding. `base` is captured by reference — the flush
        // fills the same result object the warm returns.
        base.embeddings_deferred = true;
        base.embeddings_complete = false;
        base.embeddings_skipped_reason = "deferred";
        this.#pendingEmbeddingIngests.push({ viewPath, base, embeddingScope });
        return;
      }
      await this.#ingestEmbeddingsForView({ viewPath, base, embeddingScope });
      return;
    }
    if (purpose === "wi") {
      base.embeddings_skipped_reason = `wi_embeddings_${mode}`;
    }
  }

  /**
   * Run the embeddings passes queued while `deferEmbeddings` was set. Called
   * by the conductor host after handleWarmJob returns and the write-queue slot
   * is released. Best-effort like the inline path: #ingestEmbeddingsForView
   * never throws past its own catch (failures land in base.embeddings_error).
   * @returns {Promise<number>} how many deferred passes ran
   */
  async flushDeferredEmbeddings() {
    const pending = this.#pendingEmbeddingIngests.splice(0);
    for (const item of pending) {
      if (typeof item.run === "function") await item.run();
      else await this.#ingestEmbeddingsForView(item);
    }
    return pending.length;
  }

  /**
   * Purpose === "embeddings": one budget-sliced step toward vector parity for
   * an existing view. No ledger/view writes — under the conductor the encode
   * is deferred past the serial write queue exactly like the ride-along
   * embeddings pass, so queued merges/warms never wait behind it. The caller
   * (warm job executor) re-enqueues another slice while
   * `embeddings_complete === false`.
   *
   * @param {AtlasWarmJobPayload} payload
   * @param {AtlasWarmJobResult} base
   * @returns {Promise<AtlasWarmJobResult>}
   */
  async #resumeEmbeddings(payload, base) {
    const viewPath = String(payload?.out_view_path || mainViewPath(this.#repoRoot));
    if (!fs.existsSync(viewPath)) {
      // No view yet means the views layer owns the work; its warm runs the
      // full ride-along ingest. Report complete so the resume loop ends.
      base.embeddings_skipped_reason = "view_missing";
      base.embeddings_complete = true;
      base.embeddings_remaining = 0;
      return base;
    }
    if (this.#deferEmbeddings) {
      this.#pendingEmbeddingIngests.push({
        viewPath,
        base,
        run: () => this.#resumeEmbeddingsNow({ viewPath, base, payload }),
      });
      return base;
    }
    await this.#resumeEmbeddingsNow({ viewPath, base, payload });
    return base;
  }

  /**
   * @param {{ viewPath: string, base: AtlasWarmJobResult, payload: AtlasWarmJobPayload }} args
   * @returns {Promise<void>}
   */
  async #resumeEmbeddingsNow({ viewPath, base, payload }) {
    await this.#emitStage("embeddings", `resuming embeddings for ${path.basename(viewPath)}`);
    const resources = openEmbeddingResources({
      repoRoot: this.#repoRoot,
      config: this.#runtimeConfig,
    });
    if (!resources.enabled) {
      // Embeddings off or unopenable: there is nothing for the resume loop to
      // converge on, so report complete instead of re-enqueueing forever.
      base.embeddings_provider = resources.provider;
      base.embeddings_skipped_reason = resources.reason || "disabled";
      base.embeddings_complete = true;
      base.embeddings_remaining = 0;
      return;
    }
    /** @type {View | null} */
    let view = null;
    try {
      view = View.mount({ dbPath: viewPath, mode: "readonly" });
      const maxEncode = Number.isInteger(payload?.max_symbols) && payload.max_symbols > 0
        ? payload.max_symbols
        : ATLAS_EMBEDDINGS_WARM_SLICE_SYMBOLS;
      const result = await resumeEmbeddingsSlice({
        view,
        index: /** @type {any} */ (resources.index),
        encoder: /** @type {any} */ (resources.encoder),
        repoRoot: this.#repoRoot,
        maxEncode,
      });
      base.embeddings_provider = resources.provider;
      base.embeddings_candidates = result.candidates;
      base.embeddings_indexed = result.encoded;
      base.embeddings_remaining = result.remaining;
      base.embeddings_complete = result.complete;
      if (result.skipped && result.reason && result.reason !== "fully_indexed") {
        base.embeddings_skipped_reason = result.reason;
        // Unusable encoder/index pairing (e.g. dim mismatch) cannot converge.
        base.embeddings_complete = true;
        base.embeddings_remaining = 0;
      } else if (!result.complete && result.reason) {
        base.embeddings_error = result.reason;
      }
    } catch (err) {
      logAtlasError(`[Warmer.#resumeEmbeddingsNow] viewPath=${viewPath} threw:`, err);
      base.embeddings_provider = resources.provider;
      base.embeddings_error = formatAtlasError(err);
      base.embeddings_complete = false;
    } finally {
      try { view?.close?.(); } catch { /* ignore */ }
      try { await resources.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Best-effort export of the persisted ML compression snapshot from an
   * existing view file, ahead of a full rebuild deleting it.
   *
   * @param {string} viewPath
   * @returns {object | null}
   */
  #exportMlCompressionSnapshot(viewPath) {
    if (!fs.existsSync(viewPath)) return null;
    let view = null;
    try {
      view = View.mount({ dbPath: viewPath, mode: "readonly" });
      return exportTreeCompressionMlSnapshot(view._unsafeDb());
    } catch (err) {
      logAtlasError(`[Warmer.#exportMlCompressionSnapshot] viewPath=${viewPath} threw:`, err);
      return null;
    } finally {
      try { view?.close?.(); } catch { /* ignore */ }
    }
  }

  /**
   * Best-effort re-import of a carried ML compression snapshot into the
   * freshly rebuilt view so the next reseed carries annotations forward.
   *
   * @param {string} viewPath
   * @param {object} carried
   */
  #importMlCompressionSnapshot(viewPath, carried) {
    let view = null;
    try {
      view = View.mount({ dbPath: viewPath, mode: "readwrite" });
      const result = importTreeCompressionMlSnapshot(view._unsafeDb(), /** @type {any} */ (carried));
      if (!result.ok) {
        logAtlasError(`[Warmer.#importMlCompressionSnapshot] viewPath=${viewPath} import skipped:`, new Error(result.error || "unknown"));
      }
    } catch (err) {
      logAtlasError(`[Warmer.#importMlCompressionSnapshot] viewPath=${viewPath} threw:`, err);
    } finally {
      try { view?.close?.(); } catch { /* ignore */ }
    }
  }

  /**
   * Best-effort tree-compression ML reseed. The deterministic snapshot is
   * already written inside the view build; this runs the model pass OFF that
   * (sync) build transaction so the provider call can be async. With no prior
   * ML snapshot it is the full boot seed; with a prior the binary carries
   * unchanged seeds forward and only the deltas reach the model. Main warms
   * only (work-item views are ephemeral), mode-gated, and never fails the warm.
   *
   * @param {{ viewPath: string, base: AtlasWarmJobResult, purpose: string }} args
   * @returns {Promise<void>}
   */
  async #maybeReseedTreeCompression({ viewPath, base, purpose, triggerEvent = null }) {
    const decision = shouldRunMlTreeCompressionReseed({
      purpose,
      mode: this.#treeCompressionMode,
      triggerEvent,
    });
    if (!decision.run) {
      if (decision.reason === "ml_reseed_boot_only") {
        base.tree_compression_reseed = { ok: true, skipped: decision.reason };
      }
      return;
    }
    try {
      await this.#emitStage("tree-compression", `reseeding tree compression for ${path.basename(viewPath)}`);
      const { runAtlasTreeCompressionModelPass } = await import(
        "../../../integrations/functions/atlas/tree-compression.js"
      );
      const result = await runAtlasTreeCompressionModelPass({
        viewPath,
        cwd: this.#repoRoot,
        config: this.#runtimeConfig,
      });
      base.tree_compression_reseed = result && typeof result === "object"
        ? {
            ok: result.ok === true,
            profile: result.profile ?? null,
            deltaSeeds: result.deltaSeeds ?? null,
            carriedForwardSeeds: result.carriedForwardSeeds ?? null,
            error: result.error ?? null,
          }
        : null;
    } catch (err) {
      // The deterministic snapshot is already persisted; an ML failure must
      // never break the warm. Surface it in the result for operators.
      logAtlasError(`[Warmer.#maybeReseedTreeCompression] viewPath=${viewPath} threw:`, err);
      base.tree_compression_reseed = { ok: false, error: formatAtlasError(err) };
    }
  }

  /**
   * @param {string} viewPath
   * @returns {string}
   */
  #embeddingWatermarkKey(viewPath) {
    return `view:${sha256Hex(path.resolve(viewPath))}`;
  }

  /**
   * @param {{ index: any, viewPath: string, embeddingScope?: EmbeddingIngestScope | null }} args
   * @returns {Promise<{ mode: "incremental" | "full", key: string, reason: string, watermark: Record<string, any> | null }>}
   */
  async #embeddingScopeDecision({ index, viewPath, embeddingScope = null }) {
    const key = this.#embeddingWatermarkKey(viewPath);
    if (!embeddingScope || embeddingScope.kind !== "incremental") {
      return { mode: "full", key, reason: "scope_unavailable", watermark: null };
    }
    if (typeof index?.getEmbeddingWatermark !== "function" || typeof index?.setEmbeddingWatermark !== "function") {
      return { mode: "full", key, reason: "watermark_unavailable", watermark: null };
    }
    try {
      const watermark = await index.getEmbeddingWatermark(key);
      if (
        Number(watermark?.ledger_seq) === embeddingScope.previousLedgerSeq
        && Number(watermark?.documentation_text_shape_version) === DOCUMENTATION_TEXT_SHAPE_VERSION
      ) {
        return { mode: "incremental", key, reason: "watermark_match", watermark: watermark || null };
      }
      if (
        Number(watermark?.ledger_seq) === embeddingScope.previousLedgerSeq
        && Number(watermark?.documentation_text_shape_version) !== DOCUMENTATION_TEXT_SHAPE_VERSION
      ) {
        return {
          mode: "full",
          key,
          reason: "documentation_shape_mismatch",
          watermark: watermark || null,
        };
      }
      return {
        mode: "full",
        key,
        reason: watermark ? "watermark_mismatch" : "watermark_missing",
        watermark: watermark || null,
      };
    } catch (err) {
      recordEmbeddingForensics("warmer.embeddings.watermark.read_error", {
        view_path: viewPath,
        key,
        error: errorForTelemetry(err),
      });
      return { mode: "full", key, reason: "watermark_read_error", watermark: null };
    }
  }

  /**
   * @param {{ index: any, view: View, viewPath: string, key: string }} args
   * @returns {Promise<void>}
   */
  async #writeEmbeddingWatermark({ index, view, viewPath, key }) {
    if (typeof index?.setEmbeddingWatermark !== "function") return;
    try {
      const meta = view.metaLocal();
      await index.setEmbeddingWatermark(key, {
        view_path: path.resolve(viewPath),
        branch: meta.branch,
        ledger_seq: Number.isInteger(meta.ledger_seq) ? meta.ledger_seq : 0,
        documentation_text_shape_version: DOCUMENTATION_TEXT_SHAPE_VERSION,
        view_built_at: meta.built_at ?? null,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      recordEmbeddingForensics("warmer.embeddings.watermark.write_error", {
        view_path: viewPath,
        key,
        error: errorForTelemetry(err),
      });
    }
  }

  /**
   * @param {{ view: View, base: AtlasWarmJobResult }} args
   * @returns {Promise<string[]>}
   */
  async #staleHashesSafeToPrune({ view, base }) {
    const hasContentHash = /** @type {any} */ (view.query).hasContentHash;
    if (typeof hasContentHash !== "function") return [];
    /** @type {string[]} */
    const safe = [];
    for (const hash of staleEmbeddingHashes(base)) {
      try {
        if (!(await hasContentHash.call(view.query, hash))) safe.push(hash);
      } catch {
        // Liveness unknown — keep the vectors rather than over-pruning.
      }
    }
    return safe;
  }

  /**
   * Symbol identities of every SIBLING live view (main + pre-warmed WI views)
   * so a full-scope prune keeps their vectors: the embedding store is
   * repo-global and pruning to one view's keys deleted the others' content.
   * Worktree-local view drift is a documented residual — those vectors
   * re-encode on demand. An unreadable sibling aborts the prune for this pass
   * (housekeeping retries next warm) rather than pruning a live view's keys.
   *
   * @param {string} currentViewPath
   * @returns {Promise<{ ok: true, keys: Array<{ content_hash: string, local_id: number }> } | { ok: false, reason: string }>}
   */
  async #collectSiblingViewKeepKeys(currentViewPath) {
    const current = path.resolve(String(currentViewPath || ""));
    /** @type {string[]} */
    const candidates = [];
    try {
      candidates.push(mainViewPath(this.#repoRoot));
      const warmedDir = warmedViewsDir(this.#repoRoot);
      if (fs.existsSync(warmedDir)) {
        for (const name of fs.readdirSync(warmedDir)) {
          if (name.endsWith(".view.db")) candidates.push(path.join(warmedDir, name));
        }
      }
    } catch (err) {
      return { ok: false, reason: `enumerate: ${/** @type {any} */ (err)?.message || err}` };
    }
    /** @type {Array<{ content_hash: string, local_id: number }>} */
    const keys = [];
    for (const candidate of candidates) {
      if (path.resolve(candidate) === current) continue;
      if (!fs.existsSync(candidate)) continue;
      let sibling = null;
      try {
        sibling = View.mount({ dbPath: candidate, mode: "readonly" });
        const symbols = await sibling.query.allSymbols({ limit: 100_000 });
        if (symbols.length >= 100_000) {
          // A truncated sibling keep-set would prune that view's tail — same
          // sliding-window churn the keep-cap guard prevents for the current
          // view. Abort the prune for this pass.
          return { ok: false, reason: `${path.basename(candidate)}: keep-set truncated at scan cap` };
        }
        for (const symbol of symbols) {
          keys.push(...embeddingKeysForSymbol(symbol));
        }
      } catch (err) {
        return { ok: false, reason: `${path.basename(candidate)}: ${/** @type {any} */ (err)?.message || err}` };
      } finally {
        try { sibling?.close?.(); } catch { /* best effort */ }
      }
    }
    return { ok: true, keys };
  }

  /**
   * Best-effort semantic index refresh. A failed encoder/API/native ANN
   * dependency must never make the warm job fail; the view is still the
   * primary cache. Operators get a structured error in result_json and,
   * under verbose logging, a one-line warning.
   *
   * @param {{ viewPath: string, base: AtlasWarmJobResult, embeddingScope?: EmbeddingIngestScope | null }} args
   * @returns {Promise<void>}
   */
  async #ingestEmbeddingsForView({ viewPath, base, embeddingScope = null }) {
    await this.#emitStage("embeddings", `opening embedding resources for ${path.basename(viewPath)}`);
    recordEmbeddingForensics("warmer.embeddings.start", {
      view_path: viewPath,
      repo_root: this.#repoRoot,
    });
    const resources = openEmbeddingResources({
      repoRoot: this.#repoRoot,
      config: this.#runtimeConfig,
    });
    if (!resources.enabled) {
      recordEmbeddingForensics("warmer.embeddings.disabled", {
        view_path: viewPath,
        provider: resources.provider,
        reason: resources.reason,
        backend: resources.backend,
      });
      if (resources.reason && resources.reason !== "disabled") {
        base.embeddings_provider = resources.provider;
        base.embeddings_error = resources.reason;
      }
      return;
    }

    /** @type {View | null} */
    let view = null;
    try {
      await this.#emitStage("embeddings", `encoding symbols for ${path.basename(viewPath)}`);
      view = View.mount({ dbPath: viewPath, mode: "readonly" });
      await this.#reconcileInterruptedEmbeddings({ view, resources, base, viewPath });
      const scopeDecision = await this.#embeddingScopeDecision({
        index: resources.index,
        viewPath,
        embeddingScope,
      });
      const useIncrementalScope = scopeDecision.mode === "incremental";
      /** @type {any} */ (base).embeddings_scope = useIncrementalScope ? "incremental" : "full";
      /** @type {any} */ (base).embeddings_watermark_reason = scopeDecision.reason;
      if (useIncrementalScope) {
        /** @type {any} */ (base).embeddings_touched_paths = embeddingScope?.touchedPaths?.length ?? 0;
      }
      const reconciliationStartedAt = nowMs();
      recordIntakeTelemetry(base, "embeddings.reconciliation_started", {
        recovery: !!/** @type {any} */ (base).embeddings_streaming_error,
        scope: useIncrementalScope ? "incremental" : "full",
      });
      const report = await ingestView({
        view,
        index: /** @type {any} */ (resources.index),
        encoder: /** @type {any} */ (resources.encoder),
        repoRoot: this.#repoRoot,
        onlySymbols: useIncrementalScope ? embeddingScope?.onlySymbols || [] : undefined,
        limit: useIncrementalScope
          ? Math.max(1, Number(embeddingScope?.onlySymbols?.length || 0))
          : undefined,
        signal: this.#signal,
        onProgress: (event) => {
          // Translate ingestView's structured progress into the standard
          // progress event shape so the display can render per-language bars.
          //
          // Bug history: this handler used to pick whichever language had the
          // most progress at that tick and emit a single event with that one
          // as the primary `language` / `language_current` / `language_total`.
          // The "most-progressed" language flips constantly across ticks, so
          // a consumer subscribing to per-language events saw the same row's
          // numbers dance around (e.g. js row: 6/6 then 0/188 then 4/6...).
          // `event.percent` was meanwhile an overall-across-all-languages
          // aggregate that didn't share a denominator with any single row.
          // Fix: emit one event per language, each carrying ONLY that
          // language's own correct counts. Overall progress still rides
          // along under `progress_*` for any caller that wants a headline.
          const total = event?.total || 0;
          const current = event?.current || 0;
          const percent = event?.percent ?? (total > 0 ? (current / total) * 100 : 0);
          const languageCurrent = event?.languageCurrent instanceof Map ? event.languageCurrent : new Map();
          const languageTotal = event?.languageTotal instanceof Map ? event.languageTotal : new Map();
          const breakdownObj = languageCurrent.size > 0 ? Object.fromEntries(languageCurrent) : null;
          const totalsObj = languageTotal.size > 0 ? Object.fromEntries(languageTotal) : null;
          const langs = new Set([...languageCurrent.keys(), ...languageTotal.keys()]);
          if (langs.size === 0) {
            // No per-language breakdown available — emit one headline event
            // with no language attribution. Consumers that route by language
            // will skip it; the overall progress is still in progress_*.
            this.#emitProgress({
              kind: "line",
              stream: "system",
              stage: "encoding",
              text: `encoding ${current}/${total} symbols`,
              progress_current: current,
              progress_total: total,
              percent,
              language: null,
              language_current: null,
              language_total: null,
              language_percent: null,
              language_breakdown: breakdownObj,
              language_totals: totalsObj,
            });
            return;
          }
          for (const lang of langs) {
            const langCur = languageCurrent.get(lang) || 0;
            const langTot = languageTotal.get(lang) || 0;
            const langPct = langTot > 0
              ? Math.max(0, Math.min(100, (langCur / langTot) * 100))
              : null;
            this.#emitProgress({
              kind: "line",
              stream: "system",
              stage: "encoding",
              text: `encoding ${langCur}/${langTot} ${lang} symbols`,
              progress_current: current,
              progress_total: total,
              percent,
              language: lang,
              language_current: langCur,
              language_total: langTot,
              language_percent: langPct,
              language_breakdown: breakdownObj,
              language_totals: totalsObj,
            });
          }
        },
      });
      base.embeddings_provider = resources.provider;
      base.embeddings_candidates = report.candidates;
      base.embeddings_indexed = report.indexed;
      /** @type {any} */ (base).embeddings_documentation_candidates = report.documentationCandidates;
      /** @type {any} */ (base).embeddings_documentation_indexed = report.documentationIndexed;
      /** @type {any} */ (base).embeddings_documentation_already_indexed = report.documentationAlreadyIndexed;
      /** @type {any} */ (base).embeddings_skipped_unsupported_language = report.skippedUnsupportedLanguage || 0;
      /** @type {any} */ (base).embeddings_already_indexed = report.alreadyIndexed || 0;
      recordIntakeTelemetry(base, "embeddings.reconciliation_completed", {
        recovery: !!/** @type {any} */ (base).embeddings_streaming_error,
        candidates: Number(report.candidates || 0),
        indexed: Number(report.indexed || 0),
        already_indexed: Number(report.alreadyIndexed || 0),
        duration_ms: nowMs() - reconciliationStartedAt,
      });
      if (useIncrementalScope) {
        // Incremental scope: no prune-to-view runs, so stale before-hashes
        // are removed directly — filtered by liveness so a hash whose content
        // is still current at another path keeps its vectors.
        await pruneStaleEmbeddingHashes({
          base,
          index: resources.index,
          ledger: this.#ledger,
          hashes: await this.#staleHashesSafeToPrune({ view, base }),
        });
        recordEmbeddingForensics("warmer.embeddings.prune_stale_hashes.done", {
          view_path: viewPath,
          scope: "incremental",
          base,
        });
        /** @type {any} */ (base).embeddings_prune_scope = "incremental";
        recordEmbeddingForensics("warmer.embeddings.prune_to_view.skipped", {
          view_path: viewPath,
          reason: "incremental_scope",
          base,
        });
      } else {
        const siblings = await this.#collectSiblingViewKeepKeys(viewPath);
        if (siblings.ok) {
          // Full scope: prune-to-view SUBSUMES the stale-hash prune — any
          // stale key absent from every live view falls out of the union
          // keep-set, and one that a sibling WI view still serves is
          // (correctly) kept, which the current-view-only liveness filter
          // could not see. One keys-diff also means ONE full ANN rebuild
          // (each removal path rebuilds + durable-saves the whole index —
          // running both prunes doubled the dominant cost of full warms).
          const pruneStartedAt = nowMs();
          const orphansBefore = Number(/** @type {any} */ (base).embeddings_orphans_pruned || 0);
          recordIntakeTelemetry(base, "embeddings.prune_started", {
            sibling_keep_keys: siblings.keys.length,
          });
          await pruneEmbeddingIndexToCurrentView({
            base,
            view,
            index: resources.index,
            extraKeepKeys: siblings.keys,
          });
          recordIntakeTelemetry(base, "embeddings.prune_completed", {
            removed: Math.max(0, Number(/** @type {any} */ (base).embeddings_orphans_pruned || 0) - orphansBefore),
            duration_ms: nowMs() - pruneStartedAt,
          });
          /** @type {any} */ (base).embeddings_prune_scope = "full";
          recordEmbeddingForensics("warmer.embeddings.prune_to_view.done", {
            view_path: viewPath,
            sibling_keep_keys: siblings.keys.length,
            base,
          });
        } else {
          // Housekeeping degraded: fall back to the filtered stale-hash prune
          // so replaced content still gets cleaned this pass.
          await pruneStaleEmbeddingHashes({
            base,
            index: resources.index,
            ledger: this.#ledger,
            hashes: await this.#staleHashesSafeToPrune({ view, base }),
          });
          recordEmbeddingForensics("warmer.embeddings.prune_stale_hashes.done", {
            view_path: viewPath,
            scope: "full_fallback",
            base,
          });
          /** @type {any} */ (base).embeddings_prune_scope = "skipped_sibling_unreadable";
          recordEmbeddingForensics("warmer.embeddings.prune_to_view.skipped", {
            view_path: viewPath,
            reason: `sibling_view_unreadable: ${siblings.reason}`,
            base,
          });
        }
      }
      const watermarkStartedAt = nowMs();
      recordIntakeTelemetry(base, "embeddings.watermark_started");
      await this.#writeEmbeddingWatermark({
        index: resources.index,
        view,
        viewPath,
        key: scopeDecision.key,
      });
      recordIntakeTelemetry(base, "embeddings.watermark_completed", {
        duration_ms: nowMs() - watermarkStartedAt,
      });
      const cleanup = cleanupStaleEmbeddingDirs({
        repoRoot: this.#repoRoot,
        currentModel: String(resources.encoder?.model || ""),
        currentModelVersion: String(resources.encoder?.model_version || ""),
      });
      if (cleanup.removed > 0) {
        /** @type {any} */ (base).embeddings_stale_dirs_removed = cleanup.removed;
      }
      recordEmbeddingForensics("warmer.embeddings.done", {
        view_path: viewPath,
        provider: resources.provider,
        backend: resources.backend,
        report,
        cleanup,
        base,
      });
    } catch (err) {
      const message = formatAtlasError(err);
      base.embeddings_provider = resources.provider;
      base.embeddings_error = message;
      recordEmbeddingForensics("warmer.embeddings.error", {
        view_path: viewPath,
        provider: resources.provider,
        backend: resources.backend,
        error: errorForTelemetry(err),
        base,
      });
      logAtlasError(`[Warmer.#ingestEmbeddingsForView] ${viewPath} threw:`, err);
    } finally {
      try { if (view) view.close(); } catch { /* ignore */ }
      const closeStartedAt = nowMs();
      recordIntakeTelemetry(base, "embeddings.resources_close_started");
      await resources.close();
      recordIntakeTelemetry(base, "embeddings.resources_close_completed", {
        duration_ms: nowMs() - closeStartedAt,
      });
    }
  }

  /**
   * Crash-recovery pass over the durable in-flight encode breadcrumb. If a
   * previous run died between markEncoding and clearEncoding, the breadcrumb
   * names the interrupted batch; run reconcileEmbeddings so the gap is closed
   * (and surfaced in result_json + forensics) as a KNOWN signal rather than
   * silently re-derived by the full ingest below. Best effort — a reconcile
   * failure must never fail the warm.
   *
   * @param {{ view: View, resources: ReturnType<typeof openEmbeddingResources>, base: AtlasWarmJobResult, viewPath: string }} args
   * @returns {Promise<void>}
   */
  async #reconcileInterruptedEmbeddings({ view, resources, base, viewPath }) {
    try {
      const index = /** @type {any} */ (resources.index);
      if (typeof index?.readInflight !== "function") return;
      const inflight = await index.readInflight();
      if (!inflight) return;
      await this.#emitStage("embeddings", `reconciling interrupted encode for ${path.basename(viewPath)}`);
      const result = await reconcileEmbeddings({
        view,
        index: resources.index,
        encoder: /** @type {any} */ (resources.encoder),
        repoRoot: this.#repoRoot,
      });
      /** @type {any} */ (base).embeddings_reconcile = {
        had_interrupted_batch: result.hadInterruptedBatch,
        interrupted_keys: result.interruptedKeys,
        missing: result.missing ?? null,
        encoded: result.encoded ?? null,
        incomplete: !!result.incomplete,
      };
      recordEmbeddingForensics("warmer.embeddings.reconcile.done", {
        view_path: viewPath,
        result,
      });
    } catch (err) {
      recordEmbeddingForensics("warmer.embeddings.reconcile.error", {
        view_path: viewPath,
        error: errorForTelemetry(err),
      });
      logAtlasError(`[Warmer.#reconcileInterruptedEmbeddings] ${viewPath} threw:`, err);
    }
  }
}

/**
 * @param {AtlasWarmJobResult} result
 * @param {number} start
 * @returns {AtlasWarmJobResult}
 */
function finalize(result, start) {
  result.duration_ms = nowMs() - start;
  return result;
}

function isAbortLikeError(err) {
  if (!err) return false;
  const anyErr = /** @type {any} */ (err);
  return anyErr.name === "AbortError"
    || anyErr.code === "ABORT_ERR"
    || anyErr.code === "DAEMON_ABORTED";
}

function orderedUniquePaths(paths) {
  const seen = new Set();
  const values = [];
  for (const rawPath of Array.isArray(paths) ? paths : []) {
    const repoRelPath = String(rawPath || "");
    if (!repoRelPath || seen.has(repoRelPath)) continue;
    seen.add(repoRelPath);
    values.push(repoRelPath);
  }
  return values.sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
}

function useBatchedScipStaging() {
  const requested = String(process.env.POSSE_ATLAS_SCIP_INTAKE_MODE || "batched").trim().toLowerCase();
  const batched = requested !== "whole" && requested !== "legacy" && requested !== "a";
  if (process.env.POSSE_INTAKE_BENCH_TRACE === "1") {
    console.error(JSON.stringify({
      intakeBenchmarkRoute: batched ? "stageScipBatches" : "ensureScipStaged",
      intakeMode: batched ? "batched" : "whole",
    }));
  }
  return batched;
}

function streamEmbeddingSymbol(symbol) {
  const contentHash = String(symbol?.content_hash || "");
  const localId = Number(symbol?.local_id);
  const fingerprint = sha256Hex(JSON.stringify({
    content_hash: contentHash,
    local_id: localId,
    kind: symbol?.kind ?? null,
    name: symbol?.name ?? null,
    qualified_name: symbol?.qualified_name ?? null,
    signature_hash: symbol?.signature_hash ?? null,
    signature_text: symbol?.signature_text ?? null,
    doc: symbol?.doc ?? null,
    source: symbol?.source ?? null,
  }));
  return {
    ...symbol,
    content_hash: contentHash,
    local_id: localId,
    symbol_key: `${contentHash}\0${localId}`,
    merged_fingerprint: fingerprint,
  };
}

async function symbolsMissingFromEmbeddingIndex(index, symbols) {
  const keys = symbols.map((symbol) => ({
    content_hash: symbol.content_hash,
    local_id: symbol.local_id,
  }));
  if (typeof index?.containsMany === "function") {
    try {
      const result = await index.containsMany(keys);
      const present = result instanceof Set
        ? result
        : Array.isArray(result) ? new Set(result.map(String)) : new Set();
      return symbols.filter((symbol) => !present.has(symbol.symbol_key));
    } catch { /* fall through to scalar checks */ }
  }
  if (typeof index?.contains !== "function") return symbols;
  const missing = [];
  for (const symbol of symbols) {
    let present = false;
    try { present = !!(await index.contains(symbol.content_hash, symbol.local_id)); }
    catch { present = false; }
    if (!present) missing.push(symbol);
  }
  return missing;
}

function embeddingIndexRow(row) {
  const symbolKey = String(row?.symbol_key || "");
  const separator = symbolKey.lastIndexOf("\0");
  if (separator <= 0) throw new Error(`invalid streaming embedding symbol key '${symbolKey}'`);
  const contentHash = symbolKey.slice(0, separator);
  const localId = Number(symbolKey.slice(separator + 1));
  if (!Number.isInteger(localId)) throw new Error(`invalid streaming embedding local id '${symbolKey}'`);
  return {
    content_hash: contentHash,
    local_id: localId,
    vector: row.vector,
  };
}
