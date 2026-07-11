// @ts-check

import { runAtlasNativeMethod, runAtlasNativeMethodAsync } from "./invoke.js";

export const ATLAS_STORAGE_CONTRACT_VERSION = 1;
export const ATLAS_LEDGER_ENSURE_METHOD = "ledger-ensure";
export const ATLAS_LEDGER_WRITE_METHOD = "ledger-write";
export const ATLAS_VIEW_BUILD_METHOD = "view-build";
export const ATLAS_VIEW_APPLY_METHOD = "view-apply";
export const ATLAS_VIEW_CLONE_METHOD = "view-clone";
export const ATLAS_VIEW_PATCH_META_METHOD = "view-patch-meta";

export function ensureLedgerNative(ledgerPath, opts = {}) {
  return runAtlasNativeMethod(ATLAS_LEDGER_ENSURE_METHOD, { ledger_path: ledgerPath }, opts);
}

export function writeLedgerNative(ledgerPath, operation, request, opts = {}) {
  return runAtlasNativeMethod(ATLAS_LEDGER_WRITE_METHOD, {
    ledger_path: ledgerPath,
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    operation,
    request,
  }, opts);
}

export function writeLedgerNativeAsync(ledgerPath, operation, request, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_LEDGER_WRITE_METHOD, {
    ledger_path: ledgerPath,
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    operation,
    request,
  }, opts);
}

export function buildViewNative(args, opts = {}) {
  return runAtlasNativeMethod(ATLAS_VIEW_BUILD_METHOD, buildViewPayload(args), opts);
}

export function buildViewNativeAsync(args, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_BUILD_METHOD, buildViewPayload(args), opts);
}

export function applyViewNative(args, opts = {}) {
  return runAtlasNativeMethod(ATLAS_VIEW_APPLY_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    ledger_path: args.ledgerPath,
    view_path: args.viewPath,
    entries: args.entries,
  }, opts);
}

export function applyViewNativeAsync(args, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_APPLY_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    ledger_path: args.ledgerPath,
    view_path: args.viewPath,
    entries: args.entries,
  }, opts);
}

export function cloneViewNative({ sourcePath, destPath }, opts = {}) {
  return runAtlasNativeMethod(ATLAS_VIEW_CLONE_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    source_path: sourcePath,
    dest_path: destPath,
  }, opts);
}

export function cloneViewNativeAsync({ sourcePath, destPath }, opts = {}) {
  return runAtlasNativeMethodAsync(ATLAS_VIEW_CLONE_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    source_path: sourcePath,
    dest_path: destPath,
  }, opts);
}

export function patchViewMetaNative(viewPath, meta, opts = {}) {
  return runAtlasNativeMethod(ATLAS_VIEW_PATCH_META_METHOD, {
    contract_version: ATLAS_STORAGE_CONTRACT_VERSION,
    view_path: viewPath,
    branch: meta.branch,
    parent_branch: meta.parent_branch ?? null,
    parent_seq: meta.parent_seq ?? null,
    ledger_seq: Number.isInteger(meta.ledger_seq) ? meta.ledger_seq : null,
    built_at: meta.built_at ?? null,
  }, opts);
}

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
