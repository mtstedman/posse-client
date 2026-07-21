// @ts-check
//
// Native SCIP staging hygiene. The Rust side owns protobuf mutation and path /
// source validation; this module only builds the repo-aware manifest and moves
// the file through the native method boundary.

import path from "path";
import { runAtlasNativeMethodAsync } from "../native/invoke.js";
import { computeScipPlanFilesetManifest } from "./indexers.js";
import { SCIP_SANITIZER_POLICY_VERSION } from "./sanitizer-policy.js";

export { SCIP_SANITIZER_POLICY_VERSION };

/**
 * @param {{
 *   inputPath?: string,
 *   outputPath?: string,
 *   repoRoot?: string,
 *   plan?: Record<string, any> | null,
 *   allowedPaths?: string[] | null,
 *   onProgress?: ((event: Record<string, any>) => void) | null,
 * }} input
 * @returns {Promise<{ metrics: Record<string, any>, manifest: Record<string, any>, policyVersion: string }>}
 */
export async function sanitizeScipOutputFileNative({
  inputPath,
  outputPath = inputPath,
  repoRoot,
  plan = null,
  allowedPaths = null,
  onProgress = null,
} = {}) {
  const rawInput = String(inputPath || "").trim();
  if (!rawInput) throw new Error("SCIP sanitizer inputPath is required");
  const root = path.resolve(String(repoRoot || process.cwd()));
  const inFile = path.resolve(rawInput);
  const outFile = path.resolve(String(outputPath || inFile));
  const scopedPaths = Array.isArray(allowedPaths)
    ? [...new Set(allowedPaths.map((value) => String(value || "")).filter(Boolean))]
    : null;
  const manifest = scopedPaths ? {
    ok: true,
    paths: scopedPaths,
    files: scopedPaths.length,
    source: "batch",
    ref: null,
  } : computeScipPlanFilesetManifest({ repoRoot: root, plan: /** @type {any} */ (plan || {}) });
  if (!manifest.ok && manifest.reason !== "fileset_unsupported") {
    throw new Error(`SCIP sanitizer manifest failed: ${manifest.reason || "fileset_scan_failed"}`);
  }

  emit(onProgress, `sanitizing SCIP output ${path.basename(inFile)}`, {
    kind: "atlas.scip.sanitize_started",
    language: plan?.indexerId || null,
    indexer: plan?.label || null,
    sanitizer_policy_version: SCIP_SANITIZER_POLICY_VERSION,
    manifest_files: scopedPaths?.length ?? manifest.files ?? null,
    manifest_source: scopedPaths ? "batch" : (manifest.source || null),
  });
  const result = await runAtlasNativeMethodAsync("scip-sanitize", {
    inputPath: inFile,
    outputPath: outFile,
    repoRoot: root,
    projectRoot: root,
    allowedPaths: scopedPaths || (manifest.ok ? manifest.paths : []),
    policyVersion: SCIP_SANITIZER_POLICY_VERSION,
  }, {
    timeoutMs: sanitizerTimeoutMs(plan),
  });
  const response = result && typeof result === "object"
    ? /** @type {Record<string, any>} */ (result)
    : {};
  const metrics = normalizeSanitizerMetrics(response.metrics);
  emit(onProgress, `sanitized SCIP output ${path.basename(outFile)} (${metrics.kept_documents}/${metrics.raw_documents} documents kept)`, {
    kind: "atlas.scip.sanitize_completed",
    language: plan?.indexerId || null,
    indexer: plan?.label || null,
    sanitizer_policy_version: SCIP_SANITIZER_POLICY_VERSION,
    raw_documents: metrics.raw_documents,
    kept_documents: metrics.kept_documents,
    dropped_documents: metrics.dropped_documents,
    dropped_by_reason: metrics.dropped_by_reason,
    bytes_before: metrics.bytes_before,
    bytes_after: metrics.bytes_after,
    manifest_files: scopedPaths?.length ?? manifest.files ?? null,
    manifest_source: scopedPaths ? "batch" : (manifest.source || null),
  });
  return {
    metrics,
    manifest,
    policyVersion: String(response.policyVersion || response.policy_version || SCIP_SANITIZER_POLICY_VERSION),
  };
}

function sanitizerTimeoutMs(plan = null) {
  const planTimeout = Number(plan?.timeoutMs || 0);
  if (Number.isFinite(planTimeout) && planTimeout > 0) {
    return Math.max(30_000, Math.min(planTimeout, 300_000));
  }
  return 120_000;
}

function normalizeSanitizerMetrics(value) {
  const metrics = value && typeof value === "object" ? value : {};
  return {
    raw_documents: numberField(metrics, "rawDocuments", "raw_documents"),
    kept_documents: numberField(metrics, "keptDocuments", "kept_documents"),
    dropped_documents: numberField(metrics, "droppedDocuments", "dropped_documents"),
    dropped_by_reason: objectField(metrics, "droppedByReason", "dropped_by_reason"),
    bytes_before: numberField(metrics, "bytesBefore", "bytes_before"),
    bytes_after: numberField(metrics, "bytesAfter", "bytes_after"),
  };
}

function numberField(value, camel, snake) {
  const n = Number(value?.[camel] ?? value?.[snake] ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function objectField(value, camel, snake) {
  const raw = value?.[camel] ?? value?.[snake];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function emit(onProgress, text, extra = {}) {
  if (typeof onProgress !== "function") return;
  try {
    onProgress({
      kind: extra.kind || "line",
      stream: "system",
      stage: "scip",
      text,
      ...extra,
    });
  } catch {
    // Progress is observational.
  }
}
