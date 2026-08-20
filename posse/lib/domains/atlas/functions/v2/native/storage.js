// @ts-check
//
// Async-only native storage boundary. Every ledger/view storage operation
// routes through the persistent posse-atlas worker; the synchronous one-shot
// wrappers were retired with the sync invoke path. Ledger writes are
// non-idempotent at the transport level, so they pass `idempotent: false` —
// a worker host lost mid-write reports instead of transparently retrying a
// write that may already have committed.

import {
  ATLAS_LEDGER_ENSURE_METHOD,
  ATLAS_LEDGER_WRITE_METHOD,
  ATLAS_STORAGE_CACHE_INVALIDATE_METHOD,
  ATLAS_STORAGE_CACHE_STATS_METHOD,
  ATLAS_STORAGE_CONTRACT_VERSION,
  ATLAS_VIEW_APPLY_METHOD,
  ATLAS_VIEW_BUILD_METHOD,
  ATLAS_VIEW_CLONE_METHOD,
  ATLAS_VIEW_PATCH_META_METHOD,
  ATLAS_VIEW_TREE_REFRESH_METHOD,
  ATLAS_VIEW_TREE_COMPRESSION_METHOD,
} from "../../../../../catalog/atlas.js";
import { runAtlasNativeMethodAsync } from "./invoke.js";

export {
  ATLAS_LEDGER_ENSURE_METHOD,
  ATLAS_LEDGER_WRITE_METHOD,
  ATLAS_STORAGE_CACHE_INVALIDATE_METHOD,
  ATLAS_STORAGE_CACHE_STATS_METHOD,
  ATLAS_STORAGE_CONTRACT_VERSION,
  ATLAS_VIEW_APPLY_METHOD,
  ATLAS_VIEW_BUILD_METHOD,
  ATLAS_VIEW_CLONE_METHOD,
  ATLAS_VIEW_PATCH_META_METHOD,
  ATLAS_VIEW_TREE_REFRESH_METHOD,
  ATLAS_VIEW_TREE_COMPRESSION_METHOD,
} from "../../../../../catalog/atlas.js";

export function ensureLedgerNativeAsync(ledgerPath, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_LEDGER_ENSURE_METHOD, { ledger_path: ledgerPath }, {
    idempotent: false,
    ...opts,
  });
}

export function writeLedgerNativeAsync(ledgerPath, operation, request, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_LEDGER_WRITE_METHOD, {
    ledger_path: ledgerPath,
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    operation,
    request,
  }, {
    idempotent: false,
    ...opts,
  });
}

export function buildViewNativeAsync(args, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_BUILD_METHOD, buildViewPayload(args), {
    idempotent: false,
    ...opts,
  });
}

export function applyViewNativeAsync(args, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_APPLY_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    ledger_path: args.ledgerPath,
    view_path: args.viewPath,
    entries: args.entries,
  }, {
    idempotent: false,
    ...opts,
  });
}

/**
 * Rebuild tree-derived rows transactionally inside the native storage layer.
 * The request carries only a path and the response carries only counts, so a
 * large repository's full tree never crosses the worker frame boundary.
 */
export function refreshViewTreeNativeAsync(viewPath, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_TREE_REFRESH_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    view_path: viewPath,
  }, {
    idempotent: true,
    ...opts,
  });
}

/** Build a bounded deterministic compression snapshot from persisted tree rows. */
export function buildViewTreeCompressionNativeAsync(viewPath, args = {}, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_TREE_COMPRESSION_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    view_path: viewPath,
    max_seeds: args.maxSeeds,
    max_depth: args.maxDepth,
    max_files_per_seed: args.maxFilesPerSeed,
  }, opts);
}

export function cloneViewNativeAsync({ sourcePath, destPath }, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_CLONE_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    source_path: sourcePath,
    dest_path: destPath,
  }, {
    idempotent: false,
    ...opts,
  });
}

export function patchViewMetaNativeAsync(viewPath, meta, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_PATCH_META_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    view_path: viewPath,
    branch: meta.branch,
    parent_branch: meta.parent_branch ?? null,
    parent_seq: meta.parent_seq ?? null,
    ledger_seq: Number.isInteger(meta.ledger_seq) ? meta.ledger_seq : null,
    built_at: meta.built_at ?? null,
  }, {
    idempotent: false,
    ...opts,
  });
}

/**
 * Daemon-resident storage-handle cache counters ({ opens, hits,
 * invalidations, evictions, reopened_*, read_timing }). Benchmarks and
 * diagnostics use this to prove repeated queries are not re-validating
 * databases and to separate Rust storage time from framework/IPC latency.
 */
export function storageCacheStatsNativeAsync(opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_STORAGE_CACHE_STATS_METHOD, {}, opts);
}

/**
 * Close daemon-resident SQLite handles before a Node-owned writer replaces or
 * removes their files. The method is idempotent and safe to retry.
 *
 * @param {string | string[]} paths
 */
export function invalidateStorageCacheNativeAsync(paths, opts = {}) {
  const normalized = (Array.isArray(paths) ? paths : [paths])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (normalized.length === 0) return Promise.resolve({ invalidated: 0 });
  return runAtlasNativeMethodAsync(ATLAS_STORAGE_CACHE_INVALIDATE_METHOD, { paths: normalized }, opts);
}

/**
 * @param {{
 *   ledgerPath: string,
 *   branch: string,
 *   atSeq: number,
 *   outPath: string,
 *   options?: import("../contracts/api.js").BuildOptions,
 * }} args
 */
function buildViewPayload({ ledgerPath, branch, atSeq, outPath, options = {} }) {
  const hint = options.hint;
  return {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    ledger_path: ledgerPath,
    out_path: outPath,
    branch,
    at_seq: atSeq,
    options: {
      warmed_for_files: options.warmedForFiles ?? null,
      repo_root: options.repoRoot ?? null,
      layer_merge: options.layerMerge === true,
      prefetch: hint && Array.isArray(hint.paths)
        ? {
            paths: hint.paths,
            depth: hint.depth ?? null,
            max_symbols: hint.maxSymbols ?? null,
          }
        : null,
      tree_compression_mode: normalizeCompressionMode(options.treeCompressionMode),
      tree_compression_max_seeds: options.treeCompressionMaxSeeds ?? null,
    },
  };
}

function normalizeCompressionMode(value) {
  return value === "off" || value === "ml" ? value : "deterministic";
}
