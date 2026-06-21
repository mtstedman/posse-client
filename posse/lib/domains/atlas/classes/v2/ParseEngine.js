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
//   * replayMerge(...) — sync; called at merge-to-main time. Wraps
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
import {
  exportTreeCompressionMlSnapshot,
  importTreeCompressionMlSnapshot,
} from "../../functions/v2/tree-compression.js";
import { isCanonicalRepoPath } from "../../functions/v2/paths.js";
import {
  ledgerBranchForWi,
  mainViewPath,
  warmedViewPath,
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
import { openViewWithMeta, removeSqliteFile, viewFreshness } from "../../functions/v2/view-health.js";
import { runSqliteWrite } from "../../../../shared/concurrency/functions/sqlite-gate.js";
import {
  inspectSampleForMinified,
  isOversizedForParsing,
  isLikelyMinifiedPath,
  MAX_PARSE_FILE_BYTES,
  MINIFIED_SAMPLE_BYTES,
} from "../../functions/v2/parser/index-filters.js";
import { sha256Hex } from "../../functions/v2/hash.js";
import { ingestScipFile } from "../../functions/v2/scip/ingester.js";
import { ensureScipStaged } from "../../functions/v2/scip/stager.js";
import {
  normalizeAtlasScipMode,
  shouldRunScipPhase,
} from "../../../integrations/functions/atlas-v2-mode.js";
import { resolveLanguage } from "../../functions/v2/parser/languages/index.js";
import {
  normalizedScipPath,
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

/**
 * Map a file extension (with leading dot, lowercased) to the source-language
 * tag used by ATLAS progress. These intentionally preserve JS vs TS (`js`
 * vs `ts`) even when a SCIP indexer process covers both.
 *
 * @param {string} ext
 * @returns {string | null}
 */
function languageTagForExtension(ext) {
  if (!ext) return null;
  const descriptor = resolveLanguage(ext);
  return descriptor?.tag || null;
}

/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmJobPayload} AtlasWarmJobPayload */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmJobResult} AtlasWarmJobResult */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmPurpose} AtlasWarmPurpose */
/** @typedef {import("../../functions/v2/contracts/jobs.js").AtlasWarmSkip} AtlasWarmSkip */
/** @typedef {import("../../functions/v2/contracts/schemas.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../../functions/v2/contracts/schemas.js").ParseResult} ParseResult */
/** @typedef {import("../../functions/v2/contracts/api.js").ParserAdapter} ParserAdapter */
/** @typedef {import("./Ledger.js").Ledger} Ledger */

function nowMs() {
  return Date.now();
}

/**
 * @param {Ledger} ledger
 * @param {string} contentHash
 * @returns {boolean}
 */
function ledgerHasCurrentParsedBlob(ledger, contentHash) {
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

/**
 * @param {AtlasWarmJobResult} base
 * @param {unknown} contentHash
 */
function recordStaleEmbeddingHash(base, contentHash) {
  const hash = String(contentHash || "").trim();
  if (!hash) return;
  const target = /** @type {any} */ (base);
  if (!Array.isArray(target._staleEmbeddingHashes)) target._staleEmbeddingHashes = [];
  target._staleEmbeddingHashes.push(hash);
}

/**
 * @param {AtlasWarmJobResult} base
 * @returns {string[]}
 */
function staleEmbeddingHashes(base) {
  const values = /** @type {any} */ (base)._staleEmbeddingHashes;
  return Array.isArray(values) ? [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))] : [];
}

/**
 * @param {fs.Stats | null | undefined} stat
 * @returns {number}
 */
function mtimeEpochMs(stat) {
  return Math.max(0, Math.round(Number(stat?.mtimeMs || 0)));
}

/**
 * @param {{ branch: string, repo_rel_path: string, content_hash: string, stat: fs.Stats | null | undefined }} args
 */
function sourceStatRecord({ branch, repo_rel_path, content_hash, stat }) {
  return {
    branch,
    repo_rel_path,
    content_hash,
    size_bytes: Math.max(0, Number(stat?.size || 0)),
    mtime_epoch_ms: mtimeEpochMs(stat),
    indexed_at_epoch_ms: Date.now(),
  };
}

/**
 * @param {any} stored
 * @param {fs.Stats} stat
 * @param {string} expectedHash
 * @returns {boolean}
 */
function sourceStatMatches(stored, stat, expectedHash) {
  if (!stored || !expectedHash) return false;
  return String(stored.content_hash || "") === expectedHash
    && Number(stored.size_bytes) === Number(stat.size)
    && Number(stored.mtime_epoch_ms) === mtimeEpochMs(stat);
}

/**
 * @param {{ base: AtlasWarmJobResult, index: any }} args
 * @returns {Promise<void>}
 */
async function pruneStaleEmbeddingHashes({ base, index }) {
  const hashes = staleEmbeddingHashes(base);
  if (hashes.length === 0 || typeof index?.removeByContentHash !== "function") return;
  const removed = await index.removeByContentHash(hashes);
  if (Number.isFinite(Number(removed)) && Number(removed) > 0) {
    /** @type {any} */ (base).embeddings_pruned = Number(removed);
  }
}

/**
 * @param {{ base: AtlasWarmJobResult, view: View, index: any }} args
 * @returns {Promise<void>}
 */
async function pruneEmbeddingIndexToCurrentView({ base, view, index }) {
  if (!view || typeof index?.pruneToKeys !== "function") return;
  const symbols = view.query.allSymbols({ limit: 100_000 });
  const removed = await index.pruneToKeys(symbols.map((symbol) => ({
    content_hash: symbol.content_hash,
    local_id: symbol.local_id,
  })));
  if (Number.isFinite(Number(removed)) && Number(removed) > 0) {
    /** @type {any} */ (base).embeddings_orphans_pruned = Number(removed);
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

/**
 * @param {{ meta: any, ledger: Ledger, branch: string, allowParentBranchAtSeq?: number | null, parentBranch?: string, layerMerge?: boolean | null }} args
 * @returns {{ ok: boolean, reason?: string }}
 */
function viewCanServeBranch({ meta, ledger, branch, allowParentBranchAtSeq = null, parentBranch = "main", layerMerge = null }) {
  const modeFreshness = viewFreshness(meta, null, { layerMerge });
  if (!modeFreshness.current) {
    return { ok: false, reason: modeFreshness.reason || "view build mode is stale" };
  }
  if (allowParentBranchAtSeq != null && meta?.branch === parentBranch) {
    return Number(meta.ledger_seq) === allowParentBranchAtSeq
      ? { ok: true }
      : { ok: false, reason: `${parentBranch} view seq ${Number(meta.ledger_seq) || 0} does not match fork parent ${allowParentBranchAtSeq}` };
  }
  if (!meta || meta.branch !== branch) {
    return { ok: false, reason: `view branch '${meta?.branch || "unknown"}' does not match '${branch}'` };
  }
  const freshness = viewFreshness(meta, ledger, { layerMerge });
  return freshness.current ? { ok: true } : { ok: false, reason: freshness.reason || "view is stale" };
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
  /** @type {Array<{ viewPath: string, base: AtlasWarmJobResult }>} */
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
  // getBranch lookup; first call may also issue ensureRootBranch.
  #ensureDefaultBranch() {
    if (this.#defaultBranchEnsured) return;
    if (!this.#ledger.getBranch(this.#defaultBranch) && typeof this.#ledger.ensureRootBranch === "function") {
      this.#ledger.ensureRootBranch(this.#defaultBranch);
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
    this.#emitProgress({
      kind: "line",
      stream: "system",
      stage,
      text,
      ...extra,
    });
    await this.#yieldForProgress();
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
   * Phase 0b — INGEST staged `.scip` files into the ledger, one at a time
   * (FIFO). Layer-mode boot warms may run this queue beside tree-sitter parse;
   * the queue serializes SCIP intake itself, and the boot worker keeps ledger
   * calls non-overlapping on the single JS thread.
   *
   * @param {AtlasWarmJobResult} base
   * @param {string[]} files
   * @param {{ force?: boolean }} [opts]
   */
  async #ingestScipFiles(base, files, opts = {}) {
    if (!Array.isArray(files) || files.length === 0) return;
    for (const scipPath of files) {
      try {
        await this.#emitStage("scip", `ingesting SCIP ${path.basename(scipPath)}`);
        const result = await ingestScipFile({
          ledger: this.#ledger,
          scipPath,
          repoRoot: this.#repoRoot,
          branch: this.#defaultBranch,
          force: opts.force === true,
          forceIfMissing: opts.forceIfMissing === true,
          layerOnly: this.#viewLayerMerge,
          onEvent: (event) => {
            // Forward the STRUCTURED ingest event (kind/language/current/total/
            // percent) so the boot matrix can drive the SCIP row through its
            // intaking phase to done. Previously this flattened every event to a
            // generic stage:"scip" line, stripping the kind — so the matrix only
            // ever saw "indexing" and the row hung at 100% indexing, never
            // showing intaking or reaching done. A `text` is added for the
            // activity-log/text-monitor renderer.
            this.#emitProgress({
              ...event,
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
   * Serialized SCIP intake queue. Stagers can add files as each indexer lands,
   * while tree-sitter parsing continues in parallel. The queue itself stays
   * single-file-at-a-time because all intakes share the same ledger handle.
   *
   * @param {AtlasWarmJobResult} base
   * @param {{ force?: boolean }} [opts]
   */
  #createScipIngestQueue(base, opts = {}) {
    /** @type {Set<string>} */
    const seen = new Set();
    let tail = Promise.resolve();
    const add = (scipPath) => {
      const key = normalizedScipPath(scipPath);
      if (!key || seen.has(key)) return tail;
      seen.add(key);
      const file = String(scipPath);
      tail = tail
        .catch((err) => {
          logAtlasError("[Warmer.#createScipIngestQueue] previous intake failed:", err);
        })
        .then(() => this.#ingestScipFiles(base, [file], opts));
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
      this.#ensureDefaultBranch();
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
          // Overlap: SCIP `.scip` generation runs while tree-sitter parses;
          // each finished SCIP file enters a serialized intake queue
          // immediately, while tree-sitter keeps parsing. One incremental view
          // build folds in both layers after staging + parsing + intake settle.
          const scipQueue = this.#createScipIngestQueue(base);
          const stagedScip = this.#stageScipFiles(base, "main-incremental", {
            onFileReady: (file) => { scipQueue.add(file); },
          });
          await Promise.all([
            this.#warmIncremental(payload, base, { buildView: false }),
            stagedScip.then((files) => scipQueue.addAll(files)),
          ]);
          await scipQueue.idle();
          const hintPaths = /** @type {any} */ (base)._incrementalHintPaths || null;
          return finalize(
            await this.#updateBranchViewIncremental({ payload, branch, base, hintPaths }),
            start,
          );
        }
        case "main-full": {
          if (!layerConcurrent) {
            return finalize(await this.#warmFull(payload, base), start);
          }
          const branch = payload.branch || this.#defaultBranch;
          const scipQueue = this.#createScipIngestQueue(base);
          const stagedScip = this.#stageScipFiles(base, "main-full", {
            onFileReady: (file) => { scipQueue.add(file); },
          });
          await Promise.all([
            this.#warmFull(payload, base, { buildView: false }),
            stagedScip.then((files) => scipQueue.addAll(files)),
          ]);
          await scipQueue.idle();
          return finalize(await this.#rebuildBranchView({ payload, branch, base }), start);
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
  // Synchronous ops (called inline by Workstream E hooks)
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
   * @returns {{ from: "warmed" | "main-clone" | "ledger-build" | "none", viewPath: string | null }}
   */
  mountForWorktree({ workItemId, ledgerBranch, worktreePath }) {
    if (workItemId == null) throw new TypeError("mountForWorktree: workItemId is required");
    if (!worktreePath) throw new TypeError("mountForWorktree: worktreePath is required");
    this.#ensureDefaultBranch();
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
    this.#builder.buildFrom({
      ledger: this.#ledger,
      branch: targetBranch,
      atSeq,
      outPath: dest,
      options: this.#viewBuildOptions(),
    });
    return { from: "ledger-build", viewPath: dest };
  }

  /**
   * Async gate wrapper for mountForWorktree. The underlying view and ledger
   * operations are synchronous SQLite/file work, so worker paths should await
   * this method to share the same contention contract as ATLAS's other writes.
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
   * @returns {{ removed: string[] }}
   */
  cleanupWiView({ workItemId, worktreePath, markBranchAbandoned = false }) {
    if (workItemId == null) throw new TypeError("cleanupWiView: workItemId is required");
    this.#ensureDefaultBranch();
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
        this.#ledger.setBranchStatus(branchName, "abandoned");
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
   * @returns {{ entries: LedgerEntry[] }}
   */
  replayMerge({ branch, ontoBranch = null, fromSeq = 0, markMerged = true }) {
    if (!branch) throw new TypeError("replayMerge: branch is required");
    this.#ensureDefaultBranch();
    const targetBranch = ontoBranch || this.#defaultBranch;
    const entries = this.#ledger.replayPartition(branch, targetBranch, fromSeq);
    if (markMerged) {
      const rec = this.#ledger.getBranch(branch);
      if (rec && rec.status === "active") {
        this.#ledger.setBranchStatus(branch, "merged");
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
      const entries = await this.#ledger.replayPartitionAsync(
        sourceBranch,
        ontoBranch,
        Number(payload.from_seq || 0),
        { label: "Warmer.replayMerge" },
      );
      const rec = this.#ledger.getBranch(sourceBranch);
      if (rec && rec.status === "active") {
        await this.#emitStage("merge", `marking ${sourceBranch} merged`);
        await this.#ledger.setBranchStatusAsync(sourceBranch, "merged", {
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
      if (!this.#isMergeAlreadyReflected({
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
        await this.#ledger.setBranchStatusAsync(sourceBranch, "merged", {
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
   * @param {{ branch: string, ontoBranch: string, fromSeq: number }} args
   * @returns {boolean}
   */
  #isMergeAlreadyReflected({ branch, ontoBranch, fromSeq }) {
    const source = this.#ledger.tail(branch, fromSeq);
    const destHead = this.#ledger.headSeq(ontoBranch);
    const destPaths = this.#ledger.pathSnapshotAt(ontoBranch, destHead);
    /** @type {Map<string, string | null>} */
    const expected = new Map();
    for (const entry of source) {
      expected.set(entry.repo_rel_path, entry.after_content_hash ?? null);
    }
    for (const [repoRelPath, expectedAfter] of expected.entries()) {
      const current = destPaths.get(repoRelPath) ?? null;
      if (current !== expectedAfter) return false;
    }
    return source.length > 0;
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
          try { existingMeta = existing.meta(); }
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
            const meta = cloned.meta();
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
        if (!ledgerHasCurrentParsedBlob(this.#ledger, expectedHash)) {
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
        if (ledgerHasCurrentParsedBlob(this.#ledger, contentHash)) {
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
  async #warmIncremental(payload, base, { buildView = true } = {}) {
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
    if (paths.length === 0 && String(payload?.trigger_event || "") === "boot") {
      paths = await this.#discoverBootFreshnessPaths({ branch, base });
    }
    base.paths_considered = paths.length;
    await this.#indexPaths({ paths, branch, base });
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
        const meta = view.meta();
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
        const entries = this.#ledger.tail(branch, meta.ledger_seq);
        if (entries.length === 0) {
          base.view_written = outPath;
          base.view_etag = meta.built_at;
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
        }
        try { view.close(); } catch { /* ignore */ }
        view = null;
        await this.#emitStage("view", "merged", {
          percent: 100,
          progress_current: 1,
          progress_total: 1,
        });
        await this.#emitStage("embeddings", `checking embeddings for ${path.basename(outPath)}`);
        await this.#maybeIngestEmbeddings({ viewPath: outPath, base, purpose: payload.purpose });
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
  async #warmFull(payload, base, { buildView = true } = {}) {
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
    const paths = await walkRepoFilesAsync(this.#repoRoot, (filename, relPath) => {
      const ext = path.extname(filename).toLowerCase();
      if (!ext || !(/** @type {ParserAdapter} */ (this.#parser)).supports(ext)) return false;
      // Skip well-known minified/bundled paths so we never even open them.
      // Catches *.min.js, *-min.js, *.bundle.js, *.bundle.<hash>.js etc.
      if (isLikelyMinifiedPath(relPath || filename)) return false;
      return true;
    }, { maxPaths: MAX_FULL_WARM_PATHS });
    base.paths_considered = paths.length;
    if (paths.length >= MAX_FULL_WARM_PATHS) {
      base.truncated = true;
      base.truncation_reason = `Full warm stopped at MAX_FULL_WARM_PATHS=${MAX_FULL_WARM_PATHS}`;
    }
    await this.#emitStage("walking", `found ${paths.length} supported file${paths.length === 1 ? "" : "s"}`, {
      progress_current: 0,
      progress_total: paths.length,
      percent: paths.length > 0 ? 0 : 100,
    });
    await this.#indexPaths({ paths, branch, base });
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
   * @param {{ paths: string[], branch: string, base: AtlasWarmJobResult }} args
   */
  async #indexPaths({ paths, branch, base }) {
    if (!this.#parser) return;
    await this.#emitStage("snapshot", `loading ${branch} path snapshot`);
    const headSeq = this.#ledger.headSeq(branch);
    const snapshot = headSeq > 0
      ? this.#ledger.pathSnapshotAt(branch, headSeq)
      : new Map();
    const total = paths.length;
    // Per-language totals (computed up front from path extensions) so each
    // progress event can carry { language, current_for_lang, total_for_lang }
    // and the display can render one row per language.
    const totalByLanguage = new Map();
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
      if (pathLanguage) {
        currentByLanguage.set(pathLanguage, (currentByLanguage.get(pathLanguage) || 0) + 1);
      }
      try {
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
            await this.#ledger.appendAsync({
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
          && ledgerHasCurrentParsedBlob(this.#ledger, contentHash);
        const mergeExistingScipRows = currentParsedBlob
          && shouldMergeTreeSitterRowsForScipBlob({
            ledger: this.#ledger,
            contentHash,
            repoRelPath: repo_rel_path,
          });
        if (currentParsedBlob && !mergeExistingScipRows) {
          // Same bytes and current parsed rows already on this branch.
          await recordPathSourceStat(repo_rel_path, contentHash, fileStat);
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
            ? /** @type {any} */ (this.#parser).parseBuffer({ bytes: fileBytes, repo_rel_path })
            : await this.#parser.parseFile({ absPath, repoRoot: this.#repoRoot });
        } catch (err) {
          logAtlasError(`[Warmer.#indexPaths] parse failed for ${repo_rel_path}:`, err);
          base.skipped.push({
            repo_rel_path,
            reason: "parse_error",
            message: formatAtlasError(err),
          });
          continue;
        }
        if (parsed.hasError) {
          const err = new Error(`tree-sitter parse error for ${repo_rel_path}; partial extraction discarded`);
          logAtlasError(`[Warmer.#indexPaths] recovered parse failed for ${repo_rel_path}:`, err);
          base.skipped.push({
            repo_rel_path,
            reason: "parse_error",
            message: formatAtlasError(err),
          });
          continue;
        }

        const before = beforeHash;
        if (this.#viewLayerMerge) {
          // Order-independent path: tree-sitter writes its OWN layer; the view
          // merge (buildFrom layerMerge) combines it with any SCIP layer.
          let layerByteSize = fileBytes ? fileBytes.length : 0;
          if (!layerByteSize) {
            try { layerByteSize = fs.statSync(absPath).size; }
            catch { layerByteSize = 0; }
          }
          await this.#ledger.ingestBlobLayerAsync({
            content_hash: parsed.content_hash,
            lang: parsed.lang,
            byte_size: layerByteSize,
            symbols: parsed.symbols,
            edges: parsed.edges,
            source: "treesitter",
          });
          base.blobs_ingested++;
        } else {
        if (before === parsed.content_hash && ledgerHasCurrentParsedBlob(this.#ledger, parsed.content_hash)) {
          if (mergeExistingScipRows && typeof /** @type {any} */ (this.#ledger).mergeBlobParseRowsAsync === "function") {
            await reportIndexProgress(repo_rel_path, {
              force: true,
              stage: "writing ledger",
              current: ordinal,
              text: `merging parser rows ${ordinal}/${total} ${repo_rel_path}`,
              language: pathLanguage,
            });
            const merged = await /** @type {any} */ (this.#ledger).mergeBlobParseRowsAsync(parsed, {
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

        let byte_size = fileBytes ? fileBytes.length : 0;
        if (!byte_size) {
          try { byte_size = fs.statSync(absPath).size; }
          catch { byte_size = 0; }
        }

        if (ledgerHasCurrentParsedBlob(this.#ledger, parsed.content_hash)) {
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
          await this.#ledger.ingestBlobAsync({
            content_hash: parsed.content_hash,
            lang: parsed.lang,
            byte_size,
            symbols: parsed.symbols,
            edges: parsed.edges,
          });
          base.blobs_ingested++;
        }
        }

        if (before === parsed.content_hash) {
          if (this.#viewLayerMerge) /** @type {any} */ (base)._forceViewRebuild = true;
          await recordPathSourceStat(repo_rel_path, parsed.content_hash, fileStat);
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
        await this.#ledger.appendAsync({
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
      } finally {
        await reportIndexProgress(repo_rel_path, { force: considered === total, language: pathLanguage });
      }
    }
  }

  /**
   * @param {{ viewPath: string, base: AtlasWarmJobResult, purpose: AtlasWarmPurpose }} args
   * @returns {Promise<void>}
   */
  async #maybeIngestEmbeddings({ viewPath, base, purpose }) {
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
        this.#pendingEmbeddingIngests.push({ viewPath, base });
        return;
      }
      await this.#ingestEmbeddingsForView({ viewPath, base });
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
   * Best-effort semantic index refresh. A failed encoder/API/native ANN
   * dependency must never make the warm job fail; the view is still the
   * primary cache. Operators get a structured error in result_json and,
   * under verbose logging, a one-line warning.
   *
   * @param {{ viewPath: string, base: AtlasWarmJobResult }} args
   * @returns {Promise<void>}
   */
  async #ingestEmbeddingsForView({ viewPath, base }) {
    await this.#emitStage("embeddings", `opening embedding resources for ${path.basename(viewPath)}`);
    recordEmbeddingForensics("warmer.embeddings.start", {
      view_path: viewPath,
      repo_root: this.#repoRoot,
      config_embedding_provider: /** @type {any} */ (this.#runtimeConfig)?.embeddingProvider
        ?? /** @type {any} */ (this.#runtimeConfig)?.atlasEmbeddingProvider
        ?? null,
      config_embedding_threads: /** @type {any} */ (this.#runtimeConfig)?.embeddingThreads
        ?? /** @type {any} */ (this.#runtimeConfig)?.atlasEmbeddingThreads
        ?? /** @type {any} */ (this.#runtimeConfig)?.atlas_embedding_threads
        ?? null,
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
      const report = await ingestView({
        view,
        index: /** @type {any} */ (resources.index),
        encoder: /** @type {any} */ (resources.encoder),
        repoRoot: this.#repoRoot,
        embeddingThreads: /** @type {any} */ (this.#runtimeConfig)?.embeddingThreads
          ?? /** @type {any} */ (this.#runtimeConfig)?.atlasEmbeddingThreads
          ?? /** @type {any} */ (this.#runtimeConfig)?.atlas_embedding_threads
          ?? 1,
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
      /** @type {any} */ (base).embeddings_skipped_unsupported_language = report.skippedUnsupportedLanguage || 0;
      /** @type {any} */ (base).embeddings_already_indexed = report.alreadyIndexed || 0;
      await pruneStaleEmbeddingHashes({ base, index: resources.index });
      recordEmbeddingForensics("warmer.embeddings.prune_stale_hashes.done", {
        view_path: viewPath,
        base,
      });
      await pruneEmbeddingIndexToCurrentView({ base, view, index: resources.index });
      recordEmbeddingForensics("warmer.embeddings.prune_to_view.done", {
        view_path: viewPath,
        base,
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
      await resources.close();
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
