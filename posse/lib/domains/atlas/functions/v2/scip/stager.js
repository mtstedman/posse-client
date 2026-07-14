// @ts-check
//
// SCIP staging producer. Warmers consume `.scip` files from
// `.posse/atlas/scip`; this module is responsible for trying to create one when
// the staging directory is empty.

import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { VALID_ATLAS_SCIP_RESTAGE_POLICIES, ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT } from "../../../../../catalog/atlas.js";
import { KeyedAsyncGate } from "../../../../../shared/concurrency/classes/AsyncGate.js";
import { getCurrentGitHeadAsync } from "../../../../integrations/functions/atlas/shared.js";
import { listScipFiles } from "./ingester.js";
import { computeScipPlanFilesetHash, countSourceFilesByExtensions, describeScipIndexerLookup, resolveScipStagePlans } from "./indexers.js";
import { normalizeAtlasScipMode, shouldRunScipPhase } from "../../../../integrations/functions/atlas-v2-mode.js";
import { formatAtlasError } from "../verbose-errors.js";
import { sha256Hex } from "../hash.js";
import { isCanonicalRepoPath } from "../paths.js";
import { createProtoReader } from "./proto-reader.js";
import { sanitizeScipOutputFileNative } from "./sanitizer.js";
import {
  buildFailedStagerMeta,
  buildRecoveredStagerMeta,
  buildStagerMeta,
  computeCommandArgsHash,
  metaIsCurrent,
  readStagerMeta,
  writeStagerMeta,
} from "./stager-meta.js";

export { resolveScipStagePlan, resolveScipStagePlans } from "./indexers.js";

// One slot per (cwd, outputPath) key — i.e. per language. The gate exists so
// concurrent callers for the SAME language serialize; different languages run
// in parallel because their keys differ.
const SCIP_STAGE_GATE = new KeyedAsyncGate({ name: "atlas-scip-stager", maxConcurrency: 1 });
export const DEFAULT_SCIP_COLD_INDEX_TIMEOUT_MS = 600_000;
const SCIP_STAGING_ORPHAN_GRACE_MS = 660_000;
const SCIP_BATCH_STAGE_INDEXERS = new Set(["typescript", "python", "php"]);
export const DEFAULT_SCIP_BATCH_MAX_FILES = 32;
export const DEFAULT_SCIP_BATCH_MAX_SOURCE_BYTES = 12 * 1024 * 1024;
export const DEFAULT_SCIP_BATCH_IN_FLIGHT = 2;
const SCIP_INDEXER_ENV_EXACT = new Set([
  "APPDATA",
  "CARGO_HOME",
  "COMPOSER_CACHE_DIR",
  "COMPOSER_HOME",
  "COMSPEC",
  "GOCACHE",
  "GOMODCACHE",
  "GONOSUMDB",
  "GOPATH",
  "GOPRIVATE",
  "GOPROXY",
  "GOROOT",
  "GOSUMDB",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "JAVA_HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "PATHEXT",
  "PIP_CACHE_DIR",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
  "RUSTUP_HOME",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);
const SCIP_INDEXER_ENV_PREFIXES = ["LC_"];
const SCIP_INDEXER_SENSITIVE_ENV_KEY_RE = /api[_-]?key|token|secret|credential|password|passwd|pwd|auth|oauth|bearer|^posse_key$/i;

/**
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   outputPath: string,
 *   label: string,
 *   source: "configured" | "auto",
 *   timeoutMs: number,
 *   indexerId?: string,
 *   commandSource?: string,
 *   sourceLanguages?: string[],
 *   sourceExtensions?: string[],
 *   commandArgsHashTimeoutMs?: number,
 *   runtimeColdTimeout?: boolean,
 * }} ScipStagePlan
 */

/**
 * Ensure a `.scip` file is staged for the repo when SCIP mode is enabled.
 * Existing staged files win; otherwise this launches a configured or
 * auto-detected indexer as a child process and streams progress.
 *
 * @param {{
 *   repoRoot?: string,
 *   scipDir?: string,
 *   mode?: string,
 *   config?: Record<string, any>,
 *   command?: string | null,
 *   args?: string[] | string | null,
 *   timeoutMs?: number | null,
 *   posseRoot?: string | null,
 *   onProgress?: ((event: Record<string, any>) => void) | null,
 *   onFileReady?: ((file: string, info: Record<string, any>) => void) | null,
 * }} args
 * @returns {Promise<{ enabled: boolean, dir: string | null, files: string[], staged: boolean, reason?: string, error?: string, results?: Array<Record<string, any>>, failedLanguages?: string[], orphanStagingRemoved?: number }>}
 */
export async function ensureScipStaged({
  repoRoot,
  scipDir = "",
  mode = "on",
  config = {},
  command = null,
  args = null,
  timeoutMs = null,
  posseRoot = null,
  onProgress = null,
  onFileReady = null,
} = {}) {
  const normalizedMode = normalizeAtlasScipMode(mode ?? config?.scipMode);
  if (!shouldRunScipPhase(normalizedMode)) {
    return { enabled: false, dir: null, files: [], staged: false, reason: "disabled", results: [] };
  }
  const root = path.resolve(String(repoRoot || process.cwd()));
  const dir = path.resolve(String(scipDir || config?.scipDir || path.join(root, ".posse", "atlas", "scip")));
  emit(onProgress, `checking SCIP directory ${dir}`);
  let files = [];
  let orphanStagingRemoved = 0;
  try {
    let dirExists = false;
    try { dirExists = fs.existsSync(dir); } catch { dirExists = false; }
    if (!dirExists) emit(onProgress, `creating SCIP directory ${dir}`);
    // mkdir({recursive:true}) is a no-op when the dir exists, so one
    // call covers both probe and create.
    await fs.promises.mkdir(dir, { recursive: true });
    const lookup = resolveScipStagePlans({
      repoRoot: root,
      scipDir: dir,
      command: command ?? config?.scipIndexCommand ?? null,
      args: args ?? config?.scipIndexArgs ?? null,
      timeoutMs: timeoutMs ?? config?.scipIndexTimeoutMs ?? null,
      posseRoot,
      languages: config?.scipLanguages ?? config?.atlas_scip_languages ?? null,
    });
    const policy = normalizeScipRestagePolicy(config?.scipRestagePolicy ?? config?.atlas_scip_restage_policy);
    const maxAgeHours = normalizeMaxAgeHours(config?.scipMaxAgeHours ?? config?.atlas_scip_max_age_hours);
    const normalTimeoutMs = normalizeTimeoutMs(timeoutMs ?? config?.scipIndexTimeoutMs ?? config?.atlas_scip_index_timeout_ms, null);
    const coldTimeoutMs = normalizeColdTimeoutMs(config?.scipColdIndexTimeoutMs ?? config?.atlas_scip_cold_index_timeout_ms, normalTimeoutMs);
    let currentHead = policy === "missing" || policy === "never" ? null : await resolveCurrentHead(root);
    orphanStagingRemoved = await cleanupOrphanStagingFiles(dir, {
      graceMs: cleanupGraceMs(config, timeoutMs),
      onProgress,
      plans: lookup.plans,
      currentHead,
      repoRoot: root,
    });
    files = await listScipFiles(dir);
    if (lookup.plans.length === 0) {
      if (files.length > 0) {
        notifyFilesReady(onFileReady, files, { reason: "already_staged", source: "existing" });
        emit(onProgress, `found ${files.length} staged SCIP file${files.length === 1 ? "" : "s"}`, {
          current: files.length,
          total: files.length,
        });
        return { enabled: true, dir, files, staged: false, reason: "already_staged", results: [], orphanStagingRemoved };
      }
      emit(onProgress, `no staged SCIP files in ${dir}; ${describeScipIndexerLookup(lookup)}`);
      return { enabled: true, dir, files: [], staged: false, reason: "indexer_unavailable", results: [], orphanStagingRemoved };
    }
    const stagedOutputs = new Set(files.map((file) => path.resolve(file).toLowerCase()));
    const decisions = [];
    for (const plan of lookup.plans) {
      const existingOutput = stagedOutputs.has(path.resolve(plan.outputPath).toLowerCase());
      const meta = await readStagerMeta(plan.outputPath);
      const fileset = resolvePlanFilesetContext(root, plan, meta, currentHead, policy);
      const decision = decideStageAction({
        plan,
        existingOutput,
        meta,
        policy,
        currentHead,
        maxAgeHours,
        filesetHash: fileset.currentHash,
        previousFilesetHash: fileset.previousHash,
      });
      decisions.push({ plan, existingOutput, meta, fileset, decision });
      emit(onProgress, `SCIP restage decision for ${plan.indexerId || plan.label}: ${decision.action} (${decision.reason})`, {
        kind: "atlas.scip.restage_decided",
        decision: decision.action,
        reason: decision.reason,
        policy,
        meta_head: meta?.head || null,
        current_head: currentHead || null,
        fileset_hash: fileset.currentHash || null,
        fileset_files: fileset.current?.files ?? null,
        fileset_source: fileset.current?.source || null,
        language: plan.indexerId || null,
        indexer: plan.label || null,
        source_languages: sourceLanguagesForPlan(plan),
      });
    }
    const pendingRows = decisions
      .filter((row) => row.decision.action === "stage")
      .map((row) => ({
        ...row,
        cold: shouldUseColdTimeout(row),
      }))
      .map((row) => ({
        ...row,
        plan: row.cold ? planWithRuntimeTimeout(row.plan, stageTimeoutMsForRow(row, coldTimeoutMs)) : row.plan,
      }));
    const skippedResults = decisions
      .filter((row) => row.decision.action !== "stage")
      .map((row) => stageOutcomeForDecision(row));
    await refreshSkippedStagerMetadata(decisions.filter((row) => row.decision.action !== "stage"), currentHead, onProgress);
    const pendingPlans = pendingRows.map((row) => row.plan);
    const pendingOutputKeys = new Set(pendingPlans.map((plan) => normalizedFileKey(plan.outputPath)));
    notifyFilesReady(
      onFileReady,
      files.filter((file) => !pendingOutputKeys.has(normalizedFileKey(file))),
      { reason: "already_staged", source: "existing" },
    );
    if (pendingPlans.length === 0 && files.length > 0) {
      emit(onProgress, `found ${files.length} staged SCIP file${files.length === 1 ? "" : "s"}`, {
        current: files.length,
        total: files.length,
      });
      return { enabled: true, dir, files, staged: false, reason: "already_staged", results: skippedResults, orphanStagingRemoved };
    }
    if (pendingPlans.length === 0 && files.length === 0 && policy === "never") {
      emit(onProgress, "SCIP staging skipped because atlas_scip_restage_policy=never");
      return { enabled: true, dir, files: [], staged: false, reason: "policy_never", results: skippedResults, orphanStagingRemoved };
    }
    if (files.length > 0) {
      emit(onProgress, `found ${files.length} staged SCIP file${files.length === 1 ? "" : "s"}; staging ${pendingPlans.length} missing SCIP index${pendingPlans.length === 1 ? "" : "es"}`, {
        current: files.length,
        total: files.length + pendingPlans.length,
      });
    }
    if (!currentHead) currentHead = await resolveCurrentHead(root);

    // Run pending per-language stagings in parallel. The gate key is per
    // (cwd, outputPath) so same-language concurrent runs still serialize, but
    // python/php/go/rust/ts can all index concurrently.
    const failures = [];
    const results = [...skippedResults];
    let stagedCount = 0;
    const stageResults = await Promise.all(pendingRows.map(async (row) => {
      const plan = row.plan;
      emit(onProgress, `staging SCIP index via ${plan.label} (${plan.commandSource})`, {
        language: plan.indexerId || null,
        indexer: plan.label || null,
        source_languages: sourceLanguagesForPlan(plan),
        timeoutMs: plan.timeoutMs,
        cold: row.cold,
      });
      try {
        const run = await stagePlanThroughGate(plan, {
          cwd: root,
          policy,
          currentHead,
          maxAgeHours,
          onProgress,
        });
        const result = { row, plan, run };
        if (run?.ok && await fileExists(plan.outputPath)) {
          notifyFileReady(onFileReady, plan.outputPath, {
            language: plan.indexerId || null,
            indexer: plan.label || null,
            source_languages: sourceLanguagesForPlan(plan),
            reason: run.skipped ? (run.reason || "already_staged") : "staged",
            source: "stage",
          });
        }
        return result;
      } catch (err) {
        return { row, plan, run: { ok: false, error: formatAtlasError(err) } };
      }
    }));
    for (const { row, plan, run } of stageResults) {
      results.push(stageOutcomeForRun({ ...row, plan }, run));
      if (!run.ok) {
        const message = run.error || `exit ${run.status ?? "unknown"}`;
        failures.push(`${plan.label}: ${message}`);
        emit(onProgress, `SCIP indexer failed (${plan.label}: ${message})`, {
          language: plan.indexerId || null,
          indexer: plan.label || null,
          source_languages: sourceLanguagesForPlan(plan),
        });
      } else if (!run.skipped) {
        stagedCount++;
      }
    }
    files = await listScipFiles(dir);
    const failedLanguages = uniqueNonEmptyStrings(results
      .filter((row) => row.ok === false)
      .flatMap((row) => Array.isArray(row.source_languages) && row.source_languages.length > 0
        ? row.source_languages
        : [row.language]));
    if (files.length === 0 && failures.length > 0) {
      const message = failures.join("; ");
      return { enabled: true, dir, files, staged: false, reason: "indexer_failed", error: message, results, failedLanguages, orphanStagingRemoved };
    }
    if (files.length === 0) {
      emit(onProgress, `SCIP indexer completed but produced no .scip files in ${dir}`);
      return { enabled: true, dir, files: [], staged: false, reason: "no_output", results, failedLanguages, orphanStagingRemoved };
    }
    if (failures.length > 0) {
      emit(onProgress, `SCIP staging produced ${files.length} file${files.length === 1 ? "" : "s"} with ${failures.length} indexer failure${failures.length === 1 ? "" : "s"}`);
    }
    emit(onProgress, `staged ${files.length} SCIP file${files.length === 1 ? "" : "s"}`, {
      current: files.length,
      total: files.length,
    });
    const reason = failures.length > 0 ? "partial_failure" : (stagedCount > 0 ? "staged" : "already_staged");
    return {
      enabled: true,
      dir,
      files,
      staged: stagedCount > 0,
      reason,
      error: failures.length > 0 ? failures.join("; ") : undefined,
      results,
      failedLanguages,
      orphanStagingRemoved,
    };
  } catch (err) {
    const message = formatAtlasError(err);
    emit(onProgress, `SCIP staging failed: ${message}`);
    return { enabled: true, dir, files, staged: false, reason: "error", error: message, results: [], orphanStagingRemoved };
  }
}

/**
 * Build the deterministic manifest used by path-preserving SCIP batch views.
 * Paths are bytewise ordered, deduplicated, and assigned ordinals before any
 * indexer starts. A batch never mixes indexers and never splits a document.
 *
 * @param {{
 *   repoRoot: string,
 *   paths: string[],
 *   plans: ScipStagePlan[],
 *   maxFiles?: number,
 *   maxSourceBytes?: number,
 * }} args
 */
export async function buildScipBatchManifest({
  repoRoot,
  paths,
  plans,
  maxFiles = DEFAULT_SCIP_BATCH_MAX_FILES,
  maxSourceBytes = DEFAULT_SCIP_BATCH_MAX_SOURCE_BYTES,
}) {
  const root = path.resolve(String(repoRoot || process.cwd()));
  const fileLimit = positiveBatchLimit(maxFiles, DEFAULT_SCIP_BATCH_MAX_FILES);
  const byteLimit = positiveBatchLimit(maxSourceBytes, DEFAULT_SCIP_BATCH_MAX_SOURCE_BYTES);
  const orderedPaths = uniqueBytewiseRepoPaths(paths);
  const planByExtension = new Map();
  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!SCIP_BATCH_STAGE_INDEXERS.has(String(plan?.indexerId || ""))) continue;
    for (const rawExtension of Array.isArray(plan?.sourceExtensions) ? plan.sourceExtensions : []) {
      const extension = String(rawExtension || "").trim().toLowerCase();
      if (extension && !planByExtension.has(extension)) planByExtension.set(extension, plan);
    }
  }

  const documents = [];
  const unavailable = [];
  for (const repoRelPath of orderedPaths) {
    if (!isCanonicalRepoPath(repoRelPath)) {
      unavailable.push({ repo_rel_path: repoRelPath, reason: "path_not_canonical" });
      continue;
    }
    const plan = planByExtension.get(path.extname(repoRelPath).toLowerCase()) || null;
    if (!plan) {
      unavailable.push({ repo_rel_path: repoRelPath, reason: "batch_indexer_unavailable" });
      continue;
    }
    const sourcePath = path.join(root, repoRelPath);
    let sourceBytes;
    try {
      sourceBytes = await fs.promises.readFile(sourcePath);
    } catch (err) {
      unavailable.push({
        repo_rel_path: repoRelPath,
        reason: "source_unavailable",
        error: formatAtlasError(err),
      });
      continue;
    }
    documents.push({
      documentOrdinal: documents.length,
      repoRelPath,
      sourceBytes: sourceBytes.length,
      contentHash: sha256Hex(sourceBytes),
      plan,
    });
  }

  const batches = [];
  let current = null;
  for (const document of documents) {
    const planChanged = current && current.plan !== document.plan;
    const fileLimitReached = current && current.documents.length >= fileLimit;
    const byteLimitReached = current
      && current.documents.length > 0
      && current.sourceBytes + document.sourceBytes > byteLimit;
    if (!current || planChanged || fileLimitReached || byteLimitReached) {
      current = {
        batchOrdinal: batches.length,
        firstDocumentOrdinal: document.documentOrdinal,
        plan: document.plan,
        sourceBytes: 0,
        documents: [],
      };
      batches.push(current);
    }
    current.documents.push(document);
    current.sourceBytes += document.sourceBytes;
  }

  for (const batch of batches) {
    batch.paths = batch.documents.map((document) => document.repoRelPath);
    batch.documentsExpected = batch.documents.length;
    batch.lastDocumentOrdinal = batch.documents.at(-1)?.documentOrdinal ?? batch.firstDocumentOrdinal;
    const batchHashPayload = batch.documents.map((document) => ({
      ordinal: document.documentOrdinal,
      path: document.repoRelPath,
      content_hash: document.contentHash,
      source_bytes: document.sourceBytes,
    }));
    batch.batchHash = sha256Hex(Buffer.from(JSON.stringify(batchHashPayload)));
  }
  const filesetHashPayload = documents.map((document) => ({
    ordinal: document.documentOrdinal,
    path: document.repoRelPath,
    content_hash: document.contentHash,
    source_bytes: document.sourceBytes,
    indexer: document.plan.indexerId,
  }));
  const filesetHash = sha256Hex(Buffer.from(JSON.stringify(filesetHashPayload)));
  return {
    filesetHash,
    documentCount: documents.length,
    batchCount: batches.length,
    maxFiles: fileLimit,
    maxSourceBytes: byteLimit,
    orderedPaths: documents.map((document) => document.repoRelPath),
    documents,
    batches,
    unavailable,
  };
}

/**
 * Stage ordered, path-preserving SCIP batches and hand each completed artifact
 * to a bounded downstream lane. The callback's returned promise is the batch
 * acknowledgement; at most `maxInFlight` unacknowledged batches are retained.
 *
 * @param {{
 *   repoRoot?: string,
 *   paths?: string[],
 *   scipDir?: string,
 *   mode?: string,
 *   config?: Record<string, any>,
 *   timeoutMs?: number | null,
 *   posseRoot?: string | null,
 *   onProgress?: ((event: Record<string, any>) => void) | null,
 *   onBatchReady?: ((file: string, info: Record<string, any>) => Promise<unknown> | unknown) | null,
 *   onFileUnavailable?: ((info: Record<string, any>) => Promise<unknown> | unknown) | null,
 * }} args
 */
export async function stageScipBatches({
  repoRoot,
  paths = [],
  scipDir = "",
  mode = "on",
  config = {},
  timeoutMs = null,
  posseRoot = null,
  onProgress = null,
  onBatchReady = null,
  onFileUnavailable = null,
} = {}) {
  const normalizedMode = normalizeAtlasScipMode(mode ?? config?.scipMode);
  const root = path.resolve(String(repoRoot || process.cwd()));
  const dir = path.resolve(String(scipDir || config?.scipDir || path.join(root, ".posse", "atlas", "scip")));
  if (!shouldRunScipPhase(normalizedMode)) {
    return { enabled: false, dir: null, files: [], staged: false, reason: "disabled", results: [] };
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const lookup = resolveScipStagePlans({
    repoRoot: root,
    scipDir: dir,
    command: config?.scipIndexCommand ?? null,
    args: config?.scipIndexArgs ?? null,
    timeoutMs: timeoutMs ?? config?.scipIndexTimeoutMs ?? null,
    posseRoot,
    languages: config?.scipLanguages ?? config?.atlas_scip_languages ?? null,
  });
  const manifest = await buildScipBatchManifest({
    repoRoot: root,
    paths,
    plans: lookup.plans,
    maxFiles: config?.atlasScipBatchMaxFiles ?? config?.atlas_scip_batch_max_files,
    maxSourceBytes: config?.atlasScipBatchMaxSourceBytes ?? config?.atlas_scip_batch_max_source_bytes,
  });
  const sessionId = sha256Hex(Buffer.from(
    `${manifest.filesetHash}\0${Date.now()}\0${process.pid}\0${Math.random()}`,
  )).slice(0, 32);
  const sessionDir = path.join(dir, "batches", sessionId);
  const sessionManifestPath = path.join(sessionDir, "manifest.json");
  const maxInFlight = positiveBatchLimit(
    config?.atlasScipBatchInFlight ?? config?.atlas_scip_batch_in_flight,
    DEFAULT_SCIP_BATCH_IN_FLIGHT,
  );
  const state = {
    sessionId,
    filesetHash: manifest.filesetHash,
    documentCount: manifest.documentCount,
    batchCount: manifest.batchCount,
    maxFiles: manifest.maxFiles,
    maxSourceBytes: manifest.maxSourceBytes,
    completedBatches: [],
    failedBatches: [],
    committedDocumentOrdinal: -1,
    status: "running",
    batches: manifest.batches.map((batch) => ({
      batchOrdinal: batch.batchOrdinal,
      firstDocumentOrdinal: batch.firstDocumentOrdinal,
      lastDocumentOrdinal: batch.lastDocumentOrdinal,
      documentsExpected: batch.documentsExpected,
      sourceBytes: batch.sourceBytes,
      batchHash: batch.batchHash,
      language: batch.plan.indexerId,
      paths: batch.paths,
    })),
  };
  await writeBatchSessionManifest(sessionManifestPath, state);
  for (const unavailable of manifest.unavailable) {
    await notifyFileUnavailable(onFileUnavailable, unavailable);
  }

  const files = [];
  const results = [];
  const inFlight = [];
  const acknowledgeOldest = async () => {
    const pending = inFlight.shift();
    if (!pending) return;
    await pending.ack;
    state.completedBatches.push(pending.batch.batchOrdinal);
    state.committedDocumentOrdinal = pending.batch.lastDocumentOrdinal;
    await writeBatchSessionManifest(sessionManifestPath, state);
  };

  try {
    for (const batch of manifest.batches) {
      while (inFlight.length >= maxInFlight) await acknowledgeOldest();
      emit(onProgress, `staging SCIP batch ${batch.batchOrdinal + 1}/${manifest.batchCount} (${batch.documentsExpected} documents)`, {
        kind: "atlas.scip.batch_staging_started",
        batch_ordinal: batch.batchOrdinal,
        batch_count: manifest.batchCount,
        first_document_ordinal: batch.firstDocumentOrdinal,
        documents_expected: batch.documentsExpected,
        source_bytes: batch.sourceBytes,
        language: batch.plan.indexerId,
        source_languages: sourceLanguagesForPlan(batch.plan),
      });
      const staged = await stageScipBatch({
        root,
        sessionDir,
        batch,
        onProgress,
      });
      const result = {
        ok: staged.ok === true,
        staged: staged.ok === true,
        batchOrdinal: batch.batchOrdinal,
        firstDocumentOrdinal: batch.firstDocumentOrdinal,
        documentsExpected: batch.documentsExpected,
        language: batch.plan.indexerId,
        source_languages: sourceLanguagesForPlan(batch.plan),
        outputPath: staged.outputPath || null,
        error: staged.error,
      };
      results.push(result);
      if (!staged.ok || !staged.outputPath) {
        state.failedBatches.push(batch.batchOrdinal);
        await writeBatchSessionManifest(sessionManifestPath, state);
        for (const repoRelPath of batch.paths) {
          await notifyFileUnavailable(onFileUnavailable, {
            repo_rel_path: repoRelPath,
            reason: "batch_stage_failed",
            error: staged.error || "SCIP batch staging failed",
          });
        }
        continue;
      }
      files.push(staged.outputPath);
      const info = {
        session_id: sessionId,
        batch_ordinal: batch.batchOrdinal,
        batch_count: manifest.batchCount,
        first_document_ordinal: batch.firstDocumentOrdinal,
        documents_expected: batch.documentsExpected,
        batch_sha256: staged.sha256,
        manifest_batch_hash: batch.batchHash,
        repo_rel_paths: batch.paths,
        content_hashes: Object.fromEntries(batch.documents.map((document) => [
          document.repoRelPath,
          document.contentHash,
        ])),
        language: batch.plan.indexerId,
        indexer: batch.plan.label,
        source_languages: sourceLanguagesForPlan(batch.plan),
      };
      let ack;
      try {
        ack = typeof onBatchReady === "function"
          ? Promise.resolve(onBatchReady(staged.outputPath, info))
          : Promise.resolve();
      } catch (err) {
        ack = Promise.reject(err);
      }
      inFlight.push({ batch, ack });
      emit(onProgress, `staged SCIP batch ${batch.batchOrdinal + 1}/${manifest.batchCount}`, {
        kind: "atlas.scip.batch_staged",
        batch_ordinal: batch.batchOrdinal,
        batch_count: manifest.batchCount,
        first_document_ordinal: batch.firstDocumentOrdinal,
        documents_expected: batch.documentsExpected,
        language: batch.plan.indexerId,
        source_languages: sourceLanguagesForPlan(batch.plan),
      });
    }
    while (inFlight.length > 0) await acknowledgeOldest();
    state.status = state.failedBatches.length > 0 ? "partial" : "complete";
    await writeBatchSessionManifest(sessionManifestPath, state);
    return {
      enabled: true,
      dir,
      files,
      staged: files.length > 0,
      reason: state.status,
      results,
      sessionId,
      sessionManifestPath,
      manifest,
    };
  } catch (err) {
    state.status = "failed";
    state.error = formatAtlasError(err);
    await writeBatchSessionManifest(sessionManifestPath, state).catch(() => {});
    throw err;
  }
}

async function stageScipBatch({ root, sessionDir, batch, onProgress }) {
  const batchName = `batch-${String(batch.batchOrdinal).padStart(5, "0")}`;
  const outputDir = path.join(sessionDir, batchName);
  const outputPath = path.join(outputDir, `${batch.plan.indexerId}.scip`);
  const viewParent = path.join(sessionDir, ".project-views");
  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.mkdir(viewParent, { recursive: true });
  const viewRoot = await fs.promises.mkdtemp(path.join(viewParent, `${batchName}-`));
  try {
    for (const document of batch.documents) {
      const sourcePath = path.join(root, document.repoRelPath);
      const viewPath = path.join(viewRoot, document.repoRelPath);
      await fs.promises.mkdir(path.dirname(viewPath), { recursive: true });
      await fs.promises.copyFile(sourcePath, viewPath);
      const copiedHash = sha256Hex(await fs.promises.readFile(viewPath));
      if (copiedHash !== document.contentHash) {
        return { ok: false, outputPath, error: `source changed while staging ${document.repoRelPath}` };
      }
    }
    await writeBatchProjectMetadata(viewRoot, batch);
    const rewritten = planWithOutputPath(batch.plan, outputPath);
    if (!rewritten.replaced) {
      return { ok: false, outputPath, error: `SCIP batch plan does not reference ${batch.plan.outputPath}` };
    }
    if (batch.plan.indexerId === "python"
      && rewritten.plan.args.some((arg) => String(arg).trim() === "--target-only")) {
      return { ok: false, outputPath, error: "Python SCIP batch staging forbids --target-only" };
    }
    const key = `batch::${normalizedFileKey(outputPath)}`;
    const waitMs = Math.max(30_000, Number(rewritten.plan.timeoutMs || 0) + 30_000);
    const run = await SCIP_STAGE_GATE.run(key, () => runScipIndexerAtomic(rewritten.plan, {
      cwd: viewRoot,
      repoRoot: root,
      allowedPaths: batch.paths,
      onProgress,
    }), { label: `SCIP batch ${batch.batchOrdinal}`, waitMs });
    if (!run.ok) return { ...run, outputPath };
    const bytes = await fs.promises.readFile(outputPath);
    return { ...run, ok: true, outputPath, sha256: sha256Hex(bytes) };
  } finally {
    try { await fs.promises.rm(viewRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function writeBatchProjectMetadata(viewRoot, batch) {
  if (batch.plan.indexerId === "typescript") {
    await fs.promises.writeFile(path.join(viewRoot, "tsconfig.json"), JSON.stringify({
      compilerOptions: { allowJs: true },
      files: batch.paths,
      exclude: GENERATED_INFER_TSCONFIG.exclude,
    }), "utf8");
    return;
  }
  if (batch.plan.indexerId === "php") {
    await fs.promises.writeFile(path.join(viewRoot, "composer.json"), JSON.stringify({
      autoload: { classmap: batch.paths },
    }), "utf8");
  }
  // scip-python indexes the isolated project view with its ordinary `index`
  // command. Deliberately do not add or invoke --target-only: it emits empty
  // relative paths and breaks safe merge/parity.
}

async function writeBatchSessionManifest(filePath, state) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.staging`;
  try {
    await fs.promises.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await replaceFile(tempPath, filePath);
  } finally {
    try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best effort */ }
  }
}

async function notifyFileUnavailable(callback, info) {
  if (typeof callback !== "function") return;
  try { await callback(info); } catch { /* completion notifications are observational */ }
}

function positiveBatchLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function uniqueBytewiseRepoPaths(paths) {
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

function normalizedFileKey(file) {
  const normalized = path.resolve(String(file || "")).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function notifyFileReady(onFileReady, file, info = {}) {
  if (typeof onFileReady !== "function") return;
  const readyFile = String(file || "");
  if (!readyFile) return;
  try {
    onFileReady(readyFile, info && typeof info === "object" ? info : {});
  } catch {
    // Progress/intake notifications are observational; staging owns success.
  }
}

function notifyFilesReady(onFileReady, files, info = {}) {
  const seen = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const key = normalizedFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    notifyFileReady(onFileReady, file, info);
  }
}

function resolvePlanFilesetContext(repoRoot, plan, meta, currentHead, policy = "smart") {
  const normalizedPolicy = normalizeScipRestagePolicy(policy);
  if (normalizedPolicy === "never") return emptyFilesetContext("policy_never");
  if (normalizedPolicy === "missing") return emptyFilesetContext("policy_missing");

  const ref = currentHead || null;
  const current = computeScipPlanFilesetHash({ repoRoot, plan, ref });
  const previousHash = resolvePreviousPlanFilesetHash(repoRoot, plan, meta);
  return {
    current,
    currentHash: current.ok ? current.hash : null,
    previousHash,
  };
}

function resolvePreviousPlanFilesetHash(repoRoot, plan, meta) {
  const staged = stagedMetaForFilesetFallback(meta);
  if (!staged || typeof staged !== "object") return null;
  const existing = String(staged.fileset_hash || "");
  if (existing) return existing;
  const previousHead = String(staged.head || "").trim();
  if (!previousHead) return null;
  const previous = computeScipPlanFilesetHash({ repoRoot, plan, ref: previousHead });
  return previous.ok ? previous.hash : null;
}

function stagedMetaForFilesetFallback(meta) {
  if (!meta || typeof meta !== "object") return null;
  const status = String(meta.status || "staged").trim().toLowerCase();
  if (status === "failed") {
    return meta.previous_staged && typeof meta.previous_staged === "object"
      ? stagedMetaForFilesetFallback(meta.previous_staged)
      : null;
  }
  return meta;
}

function emptyFilesetContext(reason) {
  return {
    current: { ok: false, hash: null, files: 0, source: "skipped", ref: null, reason },
    currentHash: null,
    previousHash: null,
  };
}

async function refreshSkippedStagerMetadata(rows, currentHead, onProgress = null) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row?.existingOutput || row?.decision?.action === "stage") continue;
    const reason = String(row?.decision?.reason || "");
    if (reason === "already_staged" || reason.startsWith("policy_never")) continue;
    // A failure-backoff skip must keep its failed meta intact — rewriting it
    // as "staged" would erase the attempt count and fake freshness.
    if (reason === "failure_backoff") continue;
    const filesetHash = row?.fileset?.currentHash || null;
    if (!filesetHash) continue;
    const meta = row.meta || null;
    const status = String(meta?.status || "").trim().toLowerCase();
    const alreadyCurrent = status === "staged"
      && String(meta?.head || "") === String(currentHead || "")
      && String(meta?.fileset_hash || "") === String(filesetHash);
    if (alreadyCurrent) continue;
    const metaResult = await writeStagerMeta(row.plan.outputPath, buildStagerMeta(row.plan, {
      head: currentHead,
      commandArgsHash: computeCommandArgsHash(row.plan),
      filesetHash,
      // A refresh records no new run; carry the last real duration forward so
      // history-aware stage timeouts survive head-only meta refreshes.
      durationMs: Number(stagedMetaForFilesetFallback(meta)?.staged_duration_ms) || null,
    }));
    if (!metaResult.ok) {
      emit(onProgress, `SCIP restage metadata refresh failed for ${path.basename(row.plan.outputPath)}: ${metaResult.error || "unknown"}`, {
        kind: "atlas.scip.restage_meta_failed",
        language: row.plan.indexerId || null,
        indexer: row.plan.label || null,
        source_languages: sourceLanguagesForPlan(row.plan),
      });
    }
  }
}

/**
 * @param {{
 *   repoRoot?: string,
 *   scipDir?: string,
 *   config?: Record<string, any>,
 *   command?: string | null,
 *   args?: string[] | string | null,
 *   timeoutMs?: number | null,
 *   posseRoot?: string | null,
 * }} args
 * @returns {Promise<{ policy: string, currentHead: string | null, rows: Array<Record<string, any>> }>}
 */
export async function describeScipStagingState({
  repoRoot,
  scipDir = "",
  config = {},
  command = null,
  args = null,
  timeoutMs = null,
  posseRoot = null,
} = {}) {
  const root = path.resolve(String(repoRoot || process.cwd()));
  const dir = path.resolve(String(scipDir || config?.scipDir || path.join(root, ".posse", "atlas", "scip")));
  const files = await listScipFiles(dir);
  const stagedOutputs = new Set(files.map((file) => path.resolve(file).toLowerCase()));
  const lookup = resolveScipStagePlans({
    repoRoot: root,
    scipDir: dir,
    command: command ?? config?.scipIndexCommand ?? null,
    args: args ?? config?.scipIndexArgs ?? null,
    timeoutMs: timeoutMs ?? config?.scipIndexTimeoutMs ?? null,
    posseRoot,
    languages: config?.scipLanguages ?? config?.atlas_scip_languages ?? null,
  });
  const policy = normalizeScipRestagePolicy(config?.scipRestagePolicy ?? config?.atlas_scip_restage_policy);
  const maxAgeHours = normalizeMaxAgeHours(config?.scipMaxAgeHours ?? config?.atlas_scip_max_age_hours);
  const normalTimeoutMs = normalizeTimeoutMs(timeoutMs ?? config?.scipIndexTimeoutMs ?? config?.atlas_scip_index_timeout_ms, null);
  const coldTimeoutMs = normalizeColdTimeoutMs(config?.scipColdIndexTimeoutMs ?? config?.atlas_scip_cold_index_timeout_ms, normalTimeoutMs);
  const currentHead = await resolveCurrentHead(root);
  const rows = [];
  for (const plan of lookup.plans) {
    const exists = stagedOutputs.has(path.resolve(plan.outputPath).toLowerCase());
    const meta = await readStagerMeta(plan.outputPath);
    const fileset = resolvePlanFilesetContext(root, plan, meta, currentHead, policy);
    const freshness = exists
      ? metaIsCurrent(meta, {
        head: currentHead,
        filesetHash: fileset.currentHash,
        previousFilesetHash: fileset.previousHash,
        plan,
        maxAgeHours,
      })
      : { current: false, reason: String(meta?.status || "").toLowerCase() === "failed" ? "previous_failure" : "missing_output" };
    const decision = decideStageAction({
      plan,
      existingOutput: exists,
      meta,
      policy,
      currentHead,
      maxAgeHours,
      filesetHash: fileset.currentHash,
      previousFilesetHash: fileset.previousHash,
    });
    rows.push({
      language: plan.indexerId || "configured",
      source_languages: sourceLanguagesForPlan(plan),
      label: plan.label,
      output: plan.outputPath,
      exists,
      meta,
      fresh: freshness.current,
      reason: freshness.reason,
      decision,
      meta_status: String(meta?.status || (meta ? "staged" : "") || ""),
      cold: shouldUseColdTimeout({ existingOutput: exists, meta, decision }),
      timeout_ms: shouldUseColdTimeout({ existingOutput: exists, meta, decision })
        ? stageTimeoutMsForRow({ meta }, coldTimeoutMs)
        : plan.timeoutMs,
      currentHead,
      fileset_hash: fileset.currentHash || null,
      fileset_files: fileset.current?.files ?? null,
      fileset_source: fileset.current?.source || null,
      previous_fileset_hash: fileset.previousHash || null,
    });
  }
  return { policy, currentHead, rows };
}

// Repeat-failure backoff. A failed indexer used to be relaunched on EVERY
// warm (reason previous_failure) — a deterministically broken language paid a
// failed subprocess launch per warm forever, and a hanging one paid the full
// cold timeout per warm. The failure meta carries the evidence to do better:
// retry immediately when the inputs changed (fileset or command) or when the
// failure is a first attempt; otherwise back off exponentially per attempt.
const SCIP_FAILURE_BACKOFF_BASE_MS = 5 * 60_000;
const SCIP_FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/**
 * @param {Record<string, any> | null} meta
 * @param {{ plan?: ScipStagePlan, currentHead?: string | null, filesetHash?: string | null, nowMs?: number }} input
 * @returns {{ action: "skip", reason: string } | null} skip decision, or null to allow the retry
 */
function failureBackoffDecision(meta, { plan, currentHead = null, filesetHash = null, nowMs = Date.now() } = {}) {
  if (String(meta?.status || "").trim().toLowerCase() !== "failed") return null;
  // Changed inputs are new evidence — retry immediately.
  if (String(meta?.command_args_hash || "") !== computeCommandArgsHash(plan)) return null;
  const failedFileset = String(meta?.fileset_hash || "");
  const currentFileset = String(filesetHash || "");
  if (failedFileset && currentFileset && failedFileset !== currentFileset) return null;
  if (!failedFileset || !currentFileset) {
    const failedHead = String(meta?.head || "");
    if (failedHead && currentHead && failedHead !== String(currentHead)) return null;
  }
  // First failure retries freely (transient errors, fixed environments); the
  // backoff only throttles a failure that has already been retried unchanged.
  const attempts = Math.floor(Number(meta?.attempt_count) || 1);
  if (attempts < 2) return null;
  const failedAt = Date.parse(String(meta?.failed_at || ""));
  if (!Number.isFinite(failedAt)) return null;
  const backoffMs = Math.min(
    SCIP_FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(attempts - 2, 30),
    SCIP_FAILURE_BACKOFF_MAX_MS,
  );
  if (nowMs - failedAt >= backoffMs) return null;
  return { action: "skip", reason: "failure_backoff" };
}

/**
 * @param {{
 *   plan?: ScipStagePlan,
 *   existingOutput?: boolean,
 *   meta?: Record<string, any> | null,
 *   policy?: string,
 *   currentHead?: string | null,
 *   filesetHash?: string | null,
 *   previousFilesetHash?: string | null,
 *   maxAgeHours?: number | null,
 *   nowMs?: number,
 * }} input
 * @returns {{ action: "stage" | "skip", reason: string }}
 */
export function decideStageAction({
  plan,
  existingOutput = false,
  meta = null,
  policy = "missing",
  currentHead = null,
  filesetHash = null,
  previousFilesetHash = null,
  maxAgeHours = ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT,
  nowMs = Date.now(),
} = {}) {
  const normalizedPolicy = normalizeScipRestagePolicy(policy);
  if (normalizedPolicy === "never") {
    return { action: "skip", reason: existingOutput ? "policy_never_present" : "policy_never_missing" };
  }
  if (normalizedPolicy === "always") {
    return { action: "stage", reason: existingOutput ? "policy_always" : "missing_output" };
  }
  const backoff = failureBackoffDecision(meta, { plan, currentHead, filesetHash, nowMs });
  if (normalizedPolicy === "missing") {
    if (existingOutput) return { action: "skip", reason: "already_staged" };
    if (backoff) return backoff;
    return { action: "stage", reason: String(meta?.status || "").toLowerCase() === "failed" ? "previous_failure" : "missing_output" };
  }
  if (!existingOutput) {
    if (backoff) return backoff;
    return { action: "stage", reason: String(meta?.status || "").toLowerCase() === "failed" ? "previous_failure" : "missing_output" };
  }
  const freshness = metaIsCurrent(meta, {
    head: currentHead,
    filesetHash,
    previousFilesetHash,
    plan,
    maxAgeHours,
  });
  if (freshness.current) return { action: "skip", reason: "fresh" };
  if (backoff) return backoff;
  return { action: "stage", reason: freshness.reason };
}

/**
 * @param {ScipStagePlan} plan
 * @param {{ cwd: string, policy: string, currentHead: string | null, maxAgeHours: number, onProgress?: ((event: Record<string, any>) => void) | null }} opts
 * @returns {Promise<{ ok: boolean, status?: number | null, signal?: string | null, error?: string, skipped?: boolean, reason?: string }>}
 */
async function stagePlanThroughGate(plan, { cwd, policy, currentHead, maxAgeHours, onProgress = null }) {
  const key = `${path.resolve(cwd).toLowerCase()}::${path.resolve(plan.outputPath).toLowerCase()}`;
  const waitMs = Math.max(30_000, Number(plan.timeoutMs || 0) + 30_000);
  return await SCIP_STAGE_GATE.run(key, async () => {
    const existingOutput = await fileExists(plan.outputPath);
    const meta = await readStagerMeta(plan.outputPath);
    const fileset = resolvePlanFilesetContext(cwd, plan, meta, currentHead, policy);
    const decision = decideStageAction({
      plan,
      existingOutput,
      meta,
      policy,
      currentHead,
      filesetHash: fileset.currentHash,
      previousFilesetHash: fileset.previousHash,
      maxAgeHours,
    });
    const language = plan.indexerId || null;
    const indexer = plan.label || null;
    const sourceLanguages = sourceLanguagesForPlan(plan);
    emit(onProgress, `SCIP restage gate decision for ${plan.indexerId || plan.label}: ${decision.action} (${decision.reason})`, {
      kind: "atlas.scip.restage_decided",
      decision: decision.action,
      reason: decision.reason,
      policy,
      meta_head: meta?.head || null,
      current_head: currentHead || null,
      fileset_hash: fileset.currentHash || null,
      fileset_files: fileset.current?.files ?? null,
      fileset_source: fileset.current?.source || null,
      gated: true,
      language,
      indexer,
      source_languages: sourceLanguages,
    });
    if (decision.action !== "stage") {
      await refreshSkippedStagerMetadata([{ plan, existingOutput, meta, fileset, decision }], currentHead, onProgress);
      return { ok: true, skipped: true, reason: decision.reason, fileset };
    }
    emit(onProgress, `SCIP restage started for ${plan.indexerId || plan.label}`, {
      kind: "atlas.scip.restage_started",
      policy,
      reason: decision.reason,
      language,
      indexer,
      source_languages: sourceLanguages,
      timeoutMs: plan.timeoutMs,
      cold: Boolean(plan.runtimeColdTimeout),
    });
    const stageStartedAt = Date.now();
    const run = await runScipIndexerAtomic(plan, { cwd, onProgress });
    const stageDurationMs = Date.now() - stageStartedAt;
    if (!run.ok) {
      const message = run.error || `exit ${run.status ?? "unknown"}`;
      await writeStagerMeta(plan.outputPath, buildFailedStagerMeta(plan, {
        head: currentHead,
        commandArgsHash: computeCommandArgsHash(plan),
        filesetHash: fileset.currentHash,
        reason: decision.reason,
        error: message,
        previousMeta: meta,
        durationMs: stageDurationMs,
        sanitizer: run.sanitizer || null,
      }));
      emit(onProgress, `SCIP restage failed for ${plan.indexerId || plan.label}: ${run.error || `exit ${run.status ?? "unknown"}`}`, {
        kind: "atlas.scip.restage_failed",
        policy,
        reason: decision.reason,
        language,
        indexer,
        source_languages: sourceLanguages,
        timeoutMs: plan.timeoutMs,
        cold: Boolean(plan.runtimeColdTimeout),
      });
      return { ...run, fileset };
    }
    const metaResult = await writeStagerMeta(plan.outputPath, buildStagerMeta(plan, {
      head: currentHead,
      commandArgsHash: computeCommandArgsHash(plan),
      filesetHash: fileset.currentHash,
      durationMs: stageDurationMs,
      sanitizer: run.sanitizer || null,
    }));
    if (!metaResult.ok) {
      emit(onProgress, `SCIP restage metadata write failed for ${path.basename(plan.outputPath)}: ${metaResult.error || "unknown"}`, {
      kind: "atlas.scip.restage_meta_failed",
      language,
      indexer,
      source_languages: sourceLanguages,
    });
    }
    emit(onProgress, `SCIP restage completed for ${plan.indexerId || plan.label}`, {
      kind: "atlas.scip.restage_completed",
      policy,
      reason: decision.reason,
      meta_written: metaResult.ok,
      language,
      indexer,
      source_languages: sourceLanguages,
      timeoutMs: plan.timeoutMs,
      cold: Boolean(plan.runtimeColdTimeout),
      sanitizer: run.sanitizer || null,
    });
    return { ...run, fileset };
  }, { label: `SCIP stage ${plan.indexerId || plan.label}`, waitMs });
}

/**
 * @param {ScipStagePlan} plan
 * @param {{ cwd: string, repoRoot?: string, allowedPaths?: string[] | null, onProgress?: ((event: Record<string, any>) => void) | null }} opts
 * @returns {Promise<{ ok: boolean, status?: number | null, signal?: string | null, error?: string }>}
 */
async function runScipIndexerAtomic(plan, {
  cwd,
  repoRoot = cwd,
  allowedPaths = null,
  onProgress = null,
}) {
  const tempPath = tempOutputPath(plan.outputPath);
  const rewritten = planWithOutputPath(plan, tempPath);
  const inferredTsconfig = inferredTsconfigCleanupTarget(plan, cwd);
  const hadTsconfig = inferredTsconfig ? await fileExists(inferredTsconfig) : true;
  // When the typescript indexer would infer a tsconfig (none exists), write our
  // own minimal one with allowJs so scip-typescript actually indexes .js/.jsx —
  // bare `--infer-tsconfig` generates a tsconfig WITHOUT allowJs, so .js files
  // are silently skipped and the js SCIP layer is never produced. Only written
  // when the repo has no tsconfig of its own (never clobber a user config).
  // cleanupGeneratedTsconfig removes it after the run (it recognizes this exact
  // {compilerOptions:{allowJs:true}} signature) and the startup dirty-tree guard
  // sweeps it if an interrupted run orphans it.
  if (inferredTsconfig && !hadTsconfig) {
    try {
      await fs.promises.writeFile(
        inferredTsconfig,
        JSON.stringify(GENERATED_INFER_TSCONFIG),
        "utf8",
      );
    } catch { /* best effort — fall back to scip-typescript's own --infer-tsconfig */ }
  }
  if (!rewritten.replaced) {
    emit(onProgress, `SCIP indexer args do not reference ${plan.outputPath}; running without temp-path swap`, {
      kind: "atlas.scip.restage_warning",
      reason: "output_placeholder_missing",
      language: plan.indexerId || null,
      indexer: plan.label || null,
      source_languages: sourceLanguagesForPlan(plan),
    });
    try {
      const run = await runScipIndexer(plan, { cwd, onProgress });
      if (!run.ok) return run;
      if (!(await fileExists(plan.outputPath))) {
        return { ok: false, error: `indexer completed but did not produce ${path.basename(plan.outputPath)}` };
      }
      const sanitizedPath = tempOutputPath(plan.outputPath);
      const sanitize = await sanitizeScipOutputOrValidationError({
        inputPath: plan.outputPath,
        outputPath: sanitizedPath,
        repoRoot,
        allowedPaths,
        plan,
        run,
        onProgress,
      });
      try {
        if (!sanitize.ok) return { ...run, ok: false, error: sanitize.error, scipDocuments: sanitize.scipDocuments, sanitizer: sanitize.metrics || null };
        await replaceFile(sanitizedPath, plan.outputPath);
        return { ...run, scipDocuments: sanitize.scipDocuments, sanitizer: sanitize.metrics };
      } finally {
        try { await fs.promises.rm(sanitizedPath, { force: true }); } catch { /* best effort */ }
      }
    } finally {
      await cleanupGeneratedTsconfig(inferredTsconfig, hadTsconfig);
    }
  }
  try {
    await fs.promises.rm(tempPath, { force: true });
    const run = await runScipIndexer(rewritten.plan, { cwd, onProgress });
    if (!run.ok) return run;
    if (!(await fileExists(tempPath))) {
      return { ok: false, error: `indexer completed but did not produce ${path.basename(tempPath)}` };
    }
    const sanitizedPath = tempOutputPath(plan.outputPath);
    const sanitize = await sanitizeScipOutputOrValidationError({
      inputPath: tempPath,
      outputPath: sanitizedPath,
      repoRoot,
      allowedPaths,
      plan,
      run,
      onProgress,
    });
    try {
      if (!sanitize.ok) return { ...run, ok: false, error: sanitize.error, scipDocuments: sanitize.scipDocuments, sanitizer: sanitize.metrics || null };
      await replaceFile(sanitizedPath, plan.outputPath);
      return { ...run, scipDocuments: sanitize.scipDocuments, sanitizer: sanitize.metrics };
    } finally {
      try { await fs.promises.rm(sanitizedPath, { force: true }); } catch { /* best effort */ }
    }
  } finally {
    try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best effort */ }
    await cleanupGeneratedTsconfig(inferredTsconfig, hadTsconfig);
  }
}

async function sanitizeScipOutputOrValidationError({ inputPath, outputPath, repoRoot, allowedPaths = null, plan, run, onProgress }) {
  const rawValidation = validateScipOutputFile(inputPath, run?.sourceFiles);
  if (!rawValidation.ok) {
    return {
      ok: false,
      error: rawValidation.error,
      scipDocuments: rawValidation.documents,
    };
  }
  let sanitize;
  try {
    sanitize = await sanitizeScipOutputFileNative({ inputPath, outputPath, repoRoot, plan, allowedPaths, onProgress });
  } catch (err) {
    return {
      ok: false,
      error: `SCIP sanitizer failed for ${path.basename(inputPath)}: ${formatAtlasError(err)}`,
      scipDocuments: rawValidation.documents,
    };
  }
  const sanitizedValidation = validateSanitizedScipOutputFile(outputPath);
  if (!sanitizedValidation.ok) {
    return {
      ok: false,
      error: sanitizedValidation.error,
      scipDocuments: sanitizedValidation.documents,
      metrics: sanitize.metrics,
    };
  }
  return {
    ok: true,
    ...sanitize,
    scipDocuments: sanitizedValidation.documents,
  };
}

function normalizeScipRestagePolicy(value) {
  const raw = String(value || "").trim().toLowerCase();
  return VALID_ATLAS_SCIP_RESTAGE_POLICIES.has(raw) ? raw : "missing";
}

function normalizeMaxAgeHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return ATLAS_SCIP_MAX_AGE_HOURS_DEFAULT;
  return Math.floor(n);
}

function normalizeTimeoutMs(value, fallback = null) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function normalizeColdTimeoutMs(value, normalTimeoutMs = null) {
  const configured = normalizeTimeoutMs(value, null);
  const normal = normalizeTimeoutMs(normalTimeoutMs, 0) || 0;
  return configured == null
    ? Math.max(DEFAULT_SCIP_COLD_INDEX_TIMEOUT_MS, normal)
    : Math.max(configured, normal);
}

function cleanupGraceMs(config, explicitTimeoutMs = null) {
  const normal = normalizeTimeoutMs(explicitTimeoutMs ?? config?.scipIndexTimeoutMs ?? config?.atlas_scip_index_timeout_ms, 0) || 0;
  const cold = normalizeColdTimeoutMs(config?.scipColdIndexTimeoutMs ?? config?.atlas_scip_cold_index_timeout_ms, normal);
  return Math.max(SCIP_STAGING_ORPHAN_GRACE_MS, normal, cold) + 60_000;
}

// SCIP indexers are whole-project: a restage costs the same full-index run as
// a cold boot, so EVERY stage action gets the cold ("full index") timeout. The
// short normal timeout previously applied to fileset-changed restages killed
// long indexer runs at the default 120s, threw the work away, and left the
// retry to a later warm — exactly the slow-warm-restage failure mode.
function shouldUseColdTimeout(row = {}) {
  return row?.decision?.action === "stage";
}

// Timeout for a stage run: the cold floor, stretched by the language's last
// recorded full-index duration (with headroom) when the meta has one. Evidence
// beats the generic default — a repo whose typescript index takes 9 minutes
// must not be killed at the 600s floor.
const SCIP_DURATION_TIMEOUT_HEADROOM = 2.5;
function stageTimeoutMsForRow(row = {}, coldTimeoutMs = DEFAULT_SCIP_COLD_INDEX_TIMEOUT_MS) {
  const history = Number(stagedMetaForFilesetFallback(row?.meta)?.staged_duration_ms);
  const fromHistory = Number.isFinite(history) && history > 0
    ? Math.ceil(history * SCIP_DURATION_TIMEOUT_HEADROOM)
    : 0;
  return Math.max(coldTimeoutMs, fromHistory);
}

function planWithRuntimeTimeout(plan, timeoutMs) {
  const n = normalizeTimeoutMs(timeoutMs, plan.timeoutMs);
  if (!n || n === plan.timeoutMs) return plan;
  return {
    ...plan,
    timeoutMs: n,
    commandArgsHashTimeoutMs: plan.commandArgsHashTimeoutMs ?? plan.timeoutMs,
    runtimeColdTimeout: n > Number(plan.timeoutMs || 0),
  };
}

function stageOutcomeBase(row = {}) {
  const plan = row.plan || {};
  const fileset = row.fileset?.current || row.fileset || null;
  return {
    language: plan.indexerId || "configured",
    source_languages: sourceLanguagesForPlan(plan),
    indexer: plan.label || null,
    outputPath: plan.outputPath || null,
    exists: !!row.existingOutput,
    meta_status: String(row?.meta?.status || (row?.meta ? "staged" : "") || ""),
    action: row?.decision?.action || null,
    reason: row?.decision?.reason || null,
    timeoutMs: Number(plan.timeoutMs || 0) || null,
    cold: Boolean(plan.runtimeColdTimeout || row.cold),
    fileset_hash: fileset?.hash || null,
    fileset_files: fileset?.files ?? null,
    fileset_source: fileset?.source || null,
  };
}

function sourceLanguagesForPlan(plan = {}) {
  return uniqueNonEmptyStrings(Array.isArray(plan.sourceLanguages) ? plan.sourceLanguages : []);
}

function uniqueNonEmptyStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stageOutcomeForDecision(row) {
  return {
    ...stageOutcomeBase(row),
    ok: true,
    skipped: true,
    staged: false,
  };
}

function stageOutcomeForRun(row, run = {}) {
  const message = run.error || (run.ok ? null : `exit ${run.status ?? "unknown"}`);
  const baseRow = run.fileset ? { ...row, fileset: run.fileset } : row;
  return {
    ...stageOutcomeBase(baseRow),
    ok: run.ok === true,
    skipped: run.skipped === true,
    staged: run.ok === true && run.skipped !== true,
    error: message || undefined,
    status: run.status ?? null,
    signal: run.signal ?? null,
    sanitizer: run.sanitizer || undefined,
  };
}

async function cleanupOrphanStagingFiles(dir, {
  graceMs = SCIP_STAGING_ORPHAN_GRACE_MS,
  onProgress = null,
  plans = [],
  currentHead = null,
  repoRoot = null,
} = {}) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const planByOutput = new Map((Array.isArray(plans) ? plans : [])
    .filter((plan) => plan?.outputPath)
    .map((plan) => [normalizedFileKey(plan.outputPath), plan]));
  const cutoff = Date.now() - Math.max(60_000, Number(graceMs) || SCIP_STAGING_ORPHAN_GRACE_MS);
  let removed = 0;
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^\..+\.scip\.\d+\.\d+\.[a-z0-9]+\.staging$/iu.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    let st;
    try { st = await fs.promises.stat(filePath); } catch { continue; }
    if (!st.isFile()) continue;
    const ownerPid = stagingOwnerPid(entry.name);
    const ownerAlive = ownerPid > 0 && processIsAlive(ownerPid);
    if (st.mtimeMs > cutoff && ownerAlive) continue;
    const canonicalPath = canonicalOutputPathFromStagingName(dir, entry.name);
    if (canonicalPath && await shouldRecoverOrphanStagingFile(filePath, canonicalPath, st)) {
      try {
        await replaceFile(filePath, canonicalPath);
        const plan = planByOutput.get(normalizedFileKey(canonicalPath)) || null;
        if (plan) {
          const metaResult = await writeStagerMeta(canonicalPath, buildRecoveredStagerMeta(plan, {
            head: currentHead,
            commandArgsHash: computeCommandArgsHash(plan),
          }));
          if (!metaResult.ok) {
            emit(onProgress, `recovered SCIP staging temp file but metadata write failed for ${path.basename(canonicalPath)}: ${metaResult.error || "unknown"}`, {
              kind: "atlas.scip.orphan_staging_meta_failed",
              language: plan.indexerId || null,
              indexer: plan.label || null,
              source_languages: sourceLanguagesForPlan(plan),
            });
          }
        }
        recovered++;
        continue;
      } catch {
        // Leave the valid temp in place if recovery failed; a later pass can retry.
        continue;
      }
    }
    try {
      await fs.promises.rm(filePath, { force: true });
      removed++;
    } catch {
      // Best effort; stale temp files should not block fresh staging.
    }
  }
  if (recovered > 0) {
    emit(onProgress, `recovered ${recovered} stale SCIP staging temp file${recovered === 1 ? "" : "s"}`, {
      kind: "atlas.scip.orphan_staging_recovered",
      recovered,
    });
  }
  if (removed > 0) {
    emit(onProgress, `removed ${removed} stale SCIP staging temp file${removed === 1 ? "" : "s"}`, {
      kind: "atlas.scip.orphan_staging_removed",
      removed,
    });
  }
  return removed;
}

function stagingOwnerPid(name) {
  const match = String(name || "").match(/^\..+\.scip\.(\d+)\.\d+\.[a-z0-9]+\.staging$/iu);
  const pid = match ? Number.parseInt(match[1], 10) : NaN;
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

function processIsAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function canonicalOutputPathFromStagingName(dir, name) {
  const match = String(name || "").match(/^\.(.+\.scip)\.\d+\.\d+\.[a-z0-9]+\.staging$/iu);
  return match ? path.join(dir, match[1]) : "";
}

async function shouldRecoverOrphanStagingFile(stagingPath, canonicalPath, stagingStat) {
  const documents = countScipDocumentsInFile(stagingPath);
  if (!Number.isFinite(documents) || documents <= 0) return false;
  try {
    const canonicalStat = await fs.promises.stat(canonicalPath);
    if (canonicalStat.isFile() && canonicalStat.mtimeMs >= stagingStat.mtimeMs) return false;
  } catch {
    // Missing canonical output is exactly the recovery case.
  }
  return true;
}

async function resolveCurrentHead(root) {
  try {
    return await getCurrentGitHeadAsync(root);
  } catch {
    return null;
  }
}

async function fileExists(filePath) {
  try {
    const st = await fs.promises.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function tempOutputPath(outputPath) {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath);
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  return path.join(dir, `.${base}.${suffix}.staging`);
}

function inferredTsconfigCleanupTarget(plan, cwd) {
  if ((plan.indexerId || "") !== "typescript") return null;
  const args = Array.isArray(plan.args) ? plan.args.map((arg) => String(arg)) : [];
  if (!args.includes("--infer-tsconfig")) return null;
  return path.join(cwd, "tsconfig.json");
}

// The tsconfig we generate for scip-typescript when the repo has none of its
// own. allowJs makes it index .js/.jsx (bare --infer-tsconfig skips them), but
// WITHOUT excludes TypeScript pulls in all of node_modules + build output —
// producing a 20MB+ .scip that jams ingest. exclude keeps it to repo source.
// Keep isGeneratedInferTsconfig (here) and isGeneratedInferTsconfigContent (in
// git/functions/workflows.js) in lockstep with this shape so cleanup still removes it.
const GENERATED_INFER_TSCONFIG = {
  compilerOptions: { allowJs: true },
  exclude: ["node_modules", "dist", "build", "out", "vendor", ".posse", "**/*.min.js"],
};

async function cleanupGeneratedTsconfig(filePath, existedBefore) {
  if (!filePath || existedBefore) return;
  let raw = "";
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch {
    return;
  }
  if (!isGeneratedInferTsconfig(raw)) return;
  try { await fs.promises.rm(filePath, { force: true }); } catch { /* best effort */ }
}

// Recognize a tsconfig WE generated (so cleanup only ever deletes our own, not
// a real user config). Accepts: {} (legacy bare infer), {compilerOptions:
// {allowJs:true}} (legacy), and our current shape {compilerOptions:{allowJs:
// true}, exclude:[...]}. The only keys allowed are compilerOptions (just
// allowJs:true) and an optional exclude array.
function isGeneratedInferTsconfig(raw) {
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed);
    if (keys.length === 0) return true;
    if (!keys.every((k) => k === "compilerOptions" || k === "exclude")) return false;
    if ("exclude" in parsed && !Array.isArray(parsed.exclude)) return false;
    const compilerOptions = parsed?.compilerOptions;
    return !!compilerOptions
      && Object.keys(compilerOptions).length === 1
      && compilerOptions.allowJs === true;
  } catch {
    return false;
  }
}

function planWithOutputPath(plan, outputPath) {
  const original = String(plan.outputPath || "");
  let replaced = false;
  const args = (Array.isArray(plan.args) ? plan.args : []).map((arg) => {
    const text = String(arg);
    if (original && text.includes(original)) {
      replaced = true;
      return text.replaceAll(original, outputPath);
    }
    return text;
  });
  return {
    replaced,
    plan: {
      ...plan,
      args,
      outputPath,
    },
  };
}

async function replaceFile(from, to) {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.promises.rename(from, to);
    return;
  } catch (err) {
    if (!(await fileExists(to))) throw err;
  }
  const backup = `${to}.bak-${process.pid}-${Date.now()}`;
  await fs.promises.rename(to, backup);
  try {
    await fs.promises.rename(from, to);
    try { await fs.promises.rm(backup, { force: true }); } catch { /* best effort */ }
  } catch (err) {
    try { await fs.promises.rename(backup, to); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * @param {ScipStagePlan} plan
 * @param {{ cwd: string, onProgress?: ((event: Record<string, any>) => void) | null }} opts
 * @returns {Promise<{ ok: boolean, status?: number | null, signal?: string | null, error?: string }>}
 */
function runScipIndexer(plan, { cwd, onProgress = null }) {
  return new Promise((resolve) => {
    let settled = false;
    let stderrTail = "";
    const startedAt = Date.now();
    let timer = null;
    let heartbeat = null;
    let outputPoll = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (outputPoll) clearInterval(outputPoll);
      resolve(result);
    };
    let child;
    try {
      const spawnSpec = spawnSpecForPlan(plan);
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd,
        env: scipIndexerEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (err) {
      finish({ ok: false, error: formatAtlasError(err) });
      return;
    }
    const language = plan.indexerId || null;
    const indexer = plan.label || null;
    const sourceLanguages = sourceLanguagesForPlan(plan);
    // Synthetic-progress fallback: walk the repo up-front to get the total
    // source-file count, then derive progress either from filename-per-line
    // stdout (scip-php/scip-go/scip-ruby) or from completed Document records in
    // the growing .scip output (quiet non-TTY scip-typescript).
    const extensions = Array.isArray(plan.sourceExtensions) ? plan.sourceExtensions : [];
    const fileCount = extensions.length > 0 ? countSourceFilesByExtensions(cwd, extensions) : { total: 0, capped: false };
    const syntheticTotal = fileCount.total;
    /** @type {Set<string>} */
    const seenPaths = new Set();
    const pathRe = extensions.length > 0
      ? new RegExp(`\\S+(?:${extensions.map((ext) => String(ext).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")).join("|")})\\b`, "i")
      : null;
    const progressCtx = { seenPaths, syntheticTotal, pathRe, last: { current: -1, percent: -1 } };
    const emitIndexerProgress = (stream, text, progress = null, extra = {}) => {
      emit(onProgress, `SCIP indexer ${stream}: ${text}`, {
        elapsedMs: Date.now() - startedAt,
        language,
        indexer,
        source_languages: sourceLanguages,
        stage: "scip.indexing",
        ...(progress || {}),
        ...extra,
      });
    };
    const emitOutputFileProgress = ({ force = false } = {}) => {
      const current = countScipDocumentsInFile(plan.outputPath);
      if (!Number.isFinite(current) || current <= 0 || syntheticTotal <= 0) return;
      const boundedCurrent = Math.min(current, syntheticTotal);
      const progress = {
        current: boundedCurrent,
        total: syntheticTotal,
        percent: Math.max(0, Math.min(100, (boundedCurrent / syntheticTotal) * 100)),
        synthetic: true,
        progress_source: "scip-output",
      };
      const c = Number(progress.current);
      const p = Number(progress.percent);
      const advanced = force || c > progressCtx.last.current || p > progressCtx.last.percent;
      if (!advanced) return;
      progressCtx.last.current = c;
      progressCtx.last.percent = p;
      emitIndexerProgress("generation", `${boundedCurrent}/${syntheticTotal} documents`, progress);
    };
    const handleLine = (stream, chunk) => {
      const text = String(chunk || "");
      if (stream === "stderr") stderrTail = tail(`${stderrTail}${text}`, 2000);
      for (const ev of extractScipIndexerProgressEvents(text, progressCtx)) {
        emitIndexerProgress(stream, ev.text, ev.progress);
      }
    };
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (stdout) stdout.on("data", (chunk) => handleLine("stdout", chunk));
    if (stderr) stderr.on("data", (chunk) => handleLine("stderr", chunk));
    child.on("error", (err) => finish({ ok: false, error: formatAtlasError(err) }));
    child.on("exit", (status, signal) => {
      if (outputPoll) emitOutputFileProgress({ force: true });
      finish({
        ok: status === 0,
        status,
        signal,
        sourceFiles: syntheticTotal,
        error: status === 0 ? undefined : (stderrTail.trim() || `exit ${status ?? "unknown"}`),
      });
    });
    heartbeat = setInterval(() => {
      emit(onProgress, `SCIP indexer running (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`, {
        kind: "heartbeat",
        detail: `staging SCIP index via ${plan.label}`,
        elapsedMs: Date.now() - startedAt,
        language,
        indexer,
        source_languages: sourceLanguages,
        stage: "scip.indexing",
      });
    }, 1000);
    heartbeat.unref?.();
    if (syntheticTotal > 0 && plan.outputPath) {
      outputPoll = setInterval(() => emitOutputFileProgress(), 500);
      outputPoll.unref?.();
    }
    timer = setTimeout(() => {
      killProcessTree(child);
      finish({ ok: false, error: `timed out after ${plan.timeoutMs}ms`, sourceFiles: syntheticTotal });
    }, plan.timeoutMs);
    timer.unref?.();
  });
}

function killProcessTree(child) {
  if (!child?.pid) return false;
  if (process.platform === "win32") {
    try {
      const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (killed.status === 0) return true;
    } catch {
      // Fall back to killing the direct child below.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
      return true;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  try { return child.kill("SIGTERM"); } catch { return false; }
}

/**
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
function scipIndexerEnv(baseEnv = process.env) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (!key || value == null) continue;
    if (SCIP_INDEXER_SENSITIVE_ENV_KEY_RE.test(String(key))) continue;
    const upper = String(key).toUpperCase();
    const allowed = SCIP_INDEXER_ENV_EXACT.has(upper)
      || SCIP_INDEXER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
    if (!allowed) continue;
    env[key] = String(value);
  }
  return env;
}

function spawnSpecForPlan(plan) {
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(String(plan.command || ""))) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", plan.command, ...plan.args],
    };
  }
  return { command: plan.command, args: plan.args };
}

function countScipDocumentsInFile(filePath) {
  const file = String(filePath || "");
  if (!file) return NaN;
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return NaN;
  }
  if (bytes.length === 0) return 0;
  try {
    const reader = createProtoReader(bytes);
    let documents = 0;
    while (!reader.done()) {
      const { fieldNumber, wireType } = reader.readTag();
      if (fieldNumber === 2 && wireType === 2) documents++;
      reader.skipField(wireType);
    }
    return documents;
  } catch {
    // The indexer may be mid-write; the next poll will see a complete frame.
    return NaN;
  }
}

function validateScipOutputFile(filePath, sourceFiles) {
  const totalSources = Number(sourceFiles);
  const documents = countScipDocumentsInFile(filePath);
  if (!Number.isFinite(totalSources) || totalSources <= 0) {
    return { ok: true, documents: Number.isFinite(documents) ? documents : null };
  }
  if (!Number.isFinite(documents)) {
    return {
      ok: false,
      documents: null,
      error: `indexer produced corrupt .scip output for ${Math.round(totalSources)} source file${Math.round(totalSources) === 1 ? "" : "s"}`,
    };
  }
  if (documents <= 0) {
    return {
      ok: false,
      documents,
      error: `indexer produced empty .scip output for ${Math.round(totalSources)} source file${Math.round(totalSources) === 1 ? "" : "s"}`,
    };
  }
  return { ok: true, documents };
}

function validateSanitizedScipOutputFile(filePath) {
  const documents = countScipDocumentsInFile(filePath);
  if (!Number.isFinite(documents)) {
    return {
      ok: false,
      documents: null,
      error: `SCIP sanitizer produced corrupt .scip output for ${path.basename(filePath)}`,
    };
  }
  return { ok: true, documents };
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

// SCIP indexer stdout often carries `N / M` (scip-python) or `N of M`
// (scip-typescript), e.g. "12 / 238" or "Indexing 12 of 238 files". Parse
// these into structured progress so the display can render a real % bar.
const SCIP_PROGRESS_RATIO = /(?:^|[^\d])(\d{1,7})\s*(?:\/|of)\s*(\d{1,7})(?:$|[^\d])/iu;
function parseScipIndexerProgress(text) {
  const match = String(text || "").match(SCIP_PROGRESS_RATIO);
  if (!match) return null;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  return {
    current,
    total,
    percent: Math.max(0, Math.min(100, (current / total) * 100)),
    progress_source: "indexer-ratio",
  };
}

/**
 * Break a chunk of indexer output into progress events. Splits on BOTH `\r`
 * and `\n`: `progress`-bar indexers (notably scip-typescript) redraw their
 * "N / M" bar with carriage returns only, so a `\n`-only split collapses every
 * update into one blob and the generate bar jumps straight from 0 to 100.
 * Explicit ratios (parseScipIndexerProgress) and the synthetic per-file counter
 * both feed off the split lines.
 *
 * Progress-bearing lines are gated to forward motion only — the bar redraws
 * many times a second, so a progress event is emitted only when current/percent
 * actually advances. This keeps the event log from flooding (the panel render
 * is throttled regardless) while still surfacing every real step. Non-progress
 * lines (diagnostics) always pass through.
 *
 * @param {string} text
 * @param {{ seenPaths: Set<string>, syntheticTotal: number, pathRe: RegExp | null, last: { current: number, percent: number } }} ctx
 * @returns {Array<{ text: string, progress: Record<string, any> | null }>}
 */
export function extractScipIndexerProgressEvents(text, ctx) {
  const { seenPaths, syntheticTotal, pathRe, last } = ctx;
  const out = [];
  for (const line of String(text || "").split(/\r\n|[\r\n]/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let progress = parseScipIndexerProgress(trimmed);
    // No explicit ratio — count this line as a filename against the up-front
    // total. Each unique path bumps `current`; percent is the running fraction.
    if (!progress && syntheticTotal > 0 && pathRe) {
      const match = trimmed.match(pathRe);
      if (match && !seenPaths.has(match[0])) {
        seenPaths.add(match[0]);
        const current = Math.min(seenPaths.size, syntheticTotal);
        progress = {
          current,
          total: syntheticTotal,
          percent: Math.max(0, Math.min(100, (current / syntheticTotal) * 100)),
          synthetic: true,
          progress_source: "stdout-path",
        };
      }
    }
    if (progress) {
      const c = Number.isFinite(progress.current) ? Number(progress.current) : null;
      const p = Number.isFinite(progress.percent) ? Number(progress.percent) : null;
      const advanced = (c != null && c > last.current) || (c == null && p != null && p > last.percent);
      if (!advanced) continue;
      if (c != null) last.current = c;
      if (p != null) last.percent = p;
    }
    out.push({ text: trimmed, progress: progress || null });
  }
  return out;
}


function tail(value, max) {
  const text = String(value || "");
  return text.length > max ? text.slice(text.length - max) : text;
}
