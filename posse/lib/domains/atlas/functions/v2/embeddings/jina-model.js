// @ts-check
//
// Jina model artifact ownership. Normal ATLAS operation is offline-only; the
// explicit `atlas-v2 models pull` command is the sole network boundary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATLAS_JINA_MODEL, atlasEmbeddingModelForId } from "../../../../../catalog/atlas.js";
import { ML_MODEL_PACKAGE_INSTALL_METHOD } from "../../../../../catalog/binary.js";
import { downloadLocalModelPackage, prepareLocalModelArtifactClient } from "../../../../remote/functions/local-model-artifacts.js";
import { runMlNativeMethodAsync } from "../../../../../shared/native/functions/ml-invoke.js";
import { nativeBinaries } from "../../../../../shared/tools/classes/BinaryManager.js";

export const DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const JINA_MODEL_PACKAGE_MANIFEST = ".posse-model-package.json";

/** @typedef {ReturnType<typeof atlasEmbeddingModelForId>} AtlasEmbeddingModelConfig */

/** @param {string} _repoRoot */
export function jinaModelCacheDir(_repoRoot, homeDir = os.homedir()) {
  return atlasEmbeddingModelCacheDir(ATLAS_JINA_MODEL, homeDir);
}

export function atlasEmbeddingModelCacheDir(modelConfig, homeDir = os.homedir()) {
  return path.join(
    homeDir,
    ".posse",
    "artifacts",
    "models",
    modelConfig.artifactTask,
    modelConfig.artifactPublisher,
    modelConfig.artifactRelease,
    modelConfig.mlModelDirectory,
  );
}

/**
 * Adapt the historical ATLAS cache directory to posse-ml's canonical
 * `<modelRoot>/<model-id>` layout without moving or copying a large model.
 * The compatibility link lives beside the cache, never inside it, so native
 * recursive artifact discovery cannot follow a cycle.
 *
 * @param {string} modelCacheDir
 * @returns {string} absolute model root for posse-ml's --model-root
 */
export function ensureJinaMlModelRoot(modelCacheDir) {
  return ensureAtlasEmbeddingModelRoot(ATLAS_JINA_MODEL, modelCacheDir);
}

export function ensureAtlasEmbeddingModelRoot(modelConfig, modelCacheDir) {
  const cacheDir = path.resolve(String(modelCacheDir || ""));
  if (!String(modelCacheDir || "").trim() || !directoryExists(cacheDir)) {
    const error = new Error(`${modelConfig.modelId} model cache is not a directory: ${cacheDir}`);
    /** @type {any} */ (error).code = "ATLAS_EMBEDDING_MODEL_CACHE_MISSING";
    throw error;
  }

  if (path.basename(cacheDir).toLowerCase() === modelConfig.mlModelDirectory.toLowerCase()) {
    return path.dirname(cacheDir);
  }

  const adapterRoot = path.join(
    path.dirname(cacheDir),
    ".posse-ml-model-roots",
    encodeURIComponent(path.basename(cacheDir)),
  );
  const canonicalDir = path.join(adapterRoot, modelConfig.mlModelDirectory);
  fs.mkdirSync(adapterRoot, { recursive: true });

  if (pathEntryExists(canonicalDir)) {
    const actual = realPathOrNull(canonicalDir);
    const expected = realPathOrNull(cacheDir);
    if (actual && expected && samePath(actual, expected) && directoryExists(canonicalDir)) {
      return adapterRoot;
    }
    const error = new Error(`${modelConfig.modelId} ML model adapter points at an unexpected path: ${canonicalDir}`);
    /** @type {any} */ (error).code = "ATLAS_EMBEDDING_ML_MODEL_ROOT_CONFLICT";
    throw error;
  }

  try {
    fs.symlinkSync(cacheDir, canonicalDir, process.platform === "win32" ? "junction" : "dir");
  } catch (cause) {
    const error = new Error(`Unable to prepare posse-ml model root at ${adapterRoot}`);
    /** @type {any} */ (error).code = "ATLAS_EMBEDDING_ML_MODEL_ROOT_UNAVAILABLE";
    /** @type {any} */ (error).cause = cause;
    throw error;
  }
  return adapterRoot;
}

/**
 * @param {string} repoRoot
 * @param {{ modelCacheDir?: string }} [options]
 */
export function inspectJinaModel(repoRoot, { modelCacheDir: explicitModelCacheDir } = {}) {
  return inspectAtlasEmbeddingModel(ATLAS_JINA_MODEL, repoRoot, { modelCacheDir: explicitModelCacheDir });
}

/**
 * @param {AtlasEmbeddingModelConfig} modelConfig
 * @param {string} repoRoot
 * @param {{ modelCacheDir?: string }} [options]
 */
export function inspectAtlasEmbeddingModel(modelConfig, repoRoot, { modelCacheDir: explicitModelCacheDir } = {}) {
  const modelCacheDir = explicitModelCacheDir
    ? path.resolve(explicitModelCacheDir)
    : atlasEmbeddingModelCacheDir(modelConfig);
  const files = collectFiles(modelCacheDir, 0);
  const tokenizer = files.find((file) => path.basename(file).toLowerCase() === "tokenizer.json") || null;
  const model = files.find((file) => /(^model(_quantized)?|_quantized)\.onnx$/i.test(path.basename(file)))
    || files.find((file) => file.toLowerCase().endsWith(".onnx"))
    || null;
  const packageManifestPath = path.join(modelCacheDir, JINA_MODEL_PACKAGE_MANIFEST);
  const packageManifest = readJsonObject(packageManifestPath);
  const packageCurrent = packageManifest?.schemaVersion === 1
    && packageManifest?.modelId === modelConfig.mlModelId
    && packageManifest?.version === modelConfig.artifactRelease
    && /^[a-f0-9]{64}$/u.test(String(packageManifest?.packageSha256 || ""));
  const ready = Boolean(tokenizer && model && packageCurrent);
  return {
    ready,
    modelCacheDir,
    tokenizer,
    model,
    packageManifestPath,
    packageVersion: packageManifest?.version || null,
    packageSha256: packageManifest?.packageSha256 || null,
    reason: ready ? null : tokenizer && model ? "model_package_stale" : "model_cache_missing",
  };
}

/**
 * @param {{
 *   repoRoot: string,
 *   modelCacheDir?: string,
 *   onProgress?: (progress: any) => void,
 *   manager?: import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 *   prepareClient?: typeof prepareLocalModelArtifactClient,
 *   downloadPackage?: typeof downloadLocalModelPackage,
 *   installPackage?: typeof runMlNativeMethodAsync,
 *   timeoutMs?: number,
 * }} args
 */
export async function pullJinaModel({
  repoRoot,
  modelCacheDir: explicitModelCacheDir,
  onProgress,
  manager = nativeBinaries,
  prepareClient = prepareLocalModelArtifactClient,
  downloadPackage = downloadLocalModelPackage,
  installPackage = runMlNativeMethodAsync,
  timeoutMs = DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS,
}) {
  const operationBudgetMs = normalizeOperationTimeoutMs(timeoutMs);
  const deadlineMs = Date.now() + operationBudgetMs;
  const remainingTimeoutMs = () => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new Error(`Jina download/deploy timed out after ${operationBudgetMs}ms.`);
    return Math.max(1_000, remaining);
  };
  const modelCacheDir = explicitModelCacheDir
    ? path.resolve(explicitModelCacheDir)
    : jinaModelCacheDir(repoRoot);
  if (path.basename(modelCacheDir).toLowerCase() !== ATLAS_JINA_MODEL.mlModelDirectory.toLowerCase()) {
    throw new Error(`Jina package destination must end in ${ATLAS_JINA_MODEL.mlModelDirectory}`);
  }
  const modelRoot = path.dirname(modelCacheDir);
  onProgress?.({ status: "resolving", modelId: ATLAS_JINA_MODEL.mlModelId });
  const mlAvailable = await manager.ensureAvailable("ml", { refresh: true });
  if (mlAvailable?.available !== true) {
    throw new Error(`The native ML installer is unavailable (${mlAvailable?.reason || "unknown"}).`);
  }
  const client = await prepareClient({ manager });
  onProgress?.({ status: "downloading", modelId: ATLAS_JINA_MODEL.mlModelId });
  const downloaded = await downloadPackage(client, ATLAS_JINA_MODEL.mlModelId, {
    timeoutMs: remainingTimeoutMs(),
  });
  if (downloaded.profileId !== ATLAS_JINA_MODEL.mlProfileId
    || downloaded.version !== ATLAS_JINA_MODEL.artifactRelease
    || downloaded.archiveFormat !== ATLAS_JINA_MODEL.artifactArchiveFormat
    || downloaded.archiveRoot !== ATLAS_JINA_MODEL.mlModelDirectory) {
    throw new Error(`The Jina model package does not match ${ATLAS_JINA_MODEL.mlProfileId} ${ATLAS_JINA_MODEL.artifactRelease}.`);
  }
  onProgress?.({
    status: "installing",
    modelId: ATLAS_JINA_MODEL.mlModelId,
    bytes: downloaded.bytes,
  });
  const installed = await installPackage(ML_MODEL_PACKAGE_INSTALL_METHOD, {
    modelId: downloaded.modelId,
    version: downloaded.version,
    archiveFormat: downloaded.archiveFormat,
    archiveRoot: downloaded.archiveRoot,
    packagePath: downloaded.filePath,
    expectedBytes: downloaded.bytes,
    expectedSha256: downloaded.sha256,
  }, {
    modelRoot,
    manager,
    timeoutMs: remainingTimeoutMs(),
    idempotent: false,
  });
  const inspection = inspectJinaModel(repoRoot, { modelCacheDir });
  onProgress?.({ status: "ready", modelId: ATLAS_JINA_MODEL.mlModelId });
  return { ...inspection, downloaded, installed };
}

/** @param {string} dir @param {number} depth */
function collectFiles(dir, depth) {
  if (depth > 6 || !fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isFile()) return [file];
      if (entry.isDirectory()) return collectFiles(file, depth + 1);
      return [];
    });
  } catch {
    return [];
  }
}

/** @param {string} dir */
function directoryExists(dir) {
  try { return fs.statSync(dir).isDirectory(); }
  catch { return false; }
}

/** @param {string} target */
function pathEntryExists(target) {
  try { fs.lstatSync(target); return true; }
  catch { return false; }
}

/** @param {string} target */
function realPathOrNull(target) {
  try { return fs.realpathSync.native(target); }
  catch { return null; }
}

/** @param {string} left @param {string} right */
function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** @param {string} filePath */
function readJsonObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function normalizeOperationTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1_000, parsed)
    : DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS;
}
