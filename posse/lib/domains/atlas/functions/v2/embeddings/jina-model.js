// @ts-check
//
// Jina model artifact ownership. Normal ATLAS operation is offline-only; the
// explicit `atlas-v2 models pull` command is the sole network boundary.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATLAS_JINA_MODEL } from "../../../../../catalog/atlas.js";
import { ML_MODEL_PACKAGE_INSTALL_METHOD } from "../../../../../catalog/binary.js";
import { downloadLocalModelPackage, prepareLocalModelArtifactClient } from "../../../../remote/functions/local-model-artifacts.js";
import { runMlNativeMethodAsync } from "../../../../../shared/native/functions/ml-invoke.js";
import { nativeBinaries } from "../../../../../shared/tools/classes/BinaryManager.js";

/** @param {string} repoRoot */
export function jinaModelCacheDir(_repoRoot, homeDir = os.homedir()) {
  return path.join(
    homeDir,
    ".posse",
    "artifacts",
    "models",
    ATLAS_JINA_MODEL.artifactTask,
    ATLAS_JINA_MODEL.artifactPublisher,
    ATLAS_JINA_MODEL.artifactRelease,
    ATLAS_JINA_MODEL.mlModelDirectory,
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
  const cacheDir = path.resolve(String(modelCacheDir || ""));
  if (!String(modelCacheDir || "").trim() || !directoryExists(cacheDir)) {
    const error = new Error(`Jina model cache is not a directory: ${cacheDir}`);
    /** @type {any} */ (error).code = "JINA_MODEL_CACHE_MISSING";
    throw error;
  }

  if (path.basename(cacheDir).toLowerCase() === ATLAS_JINA_MODEL.mlModelDirectory.toLowerCase()) {
    return path.dirname(cacheDir);
  }

  const adapterRoot = path.join(
    path.dirname(cacheDir),
    ".posse-ml-model-roots",
    encodeURIComponent(path.basename(cacheDir)),
  );
  const canonicalDir = path.join(adapterRoot, ATLAS_JINA_MODEL.mlModelDirectory);
  fs.mkdirSync(adapterRoot, { recursive: true });

  if (pathEntryExists(canonicalDir)) {
    const actual = realPathOrNull(canonicalDir);
    const expected = realPathOrNull(cacheDir);
    if (actual && expected && samePath(actual, expected) && directoryExists(canonicalDir)) {
      return adapterRoot;
    }
    const error = new Error(`Jina ML model adapter points at an unexpected path: ${canonicalDir}`);
    /** @type {any} */ (error).code = "JINA_ML_MODEL_ROOT_CONFLICT";
    throw error;
  }

  try {
    fs.symlinkSync(cacheDir, canonicalDir, process.platform === "win32" ? "junction" : "dir");
  } catch (cause) {
    const error = new Error(`Unable to prepare posse-ml model root at ${adapterRoot}`);
    /** @type {any} */ (error).code = "JINA_ML_MODEL_ROOT_UNAVAILABLE";
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
  const modelCacheDir = explicitModelCacheDir
    ? path.resolve(explicitModelCacheDir)
    : jinaModelCacheDir(repoRoot);
  const files = collectFiles(modelCacheDir, 0);
  const tokenizer = files.find((file) => path.basename(file).toLowerCase() === "tokenizer.json") || null;
  const model = files.find((file) => /(^model(_quantized)?|_quantized)\.onnx$/i.test(path.basename(file)))
    || files.find((file) => file.toLowerCase().endsWith(".onnx"))
    || null;
  return {
    ready: !!tokenizer && !!model,
    modelCacheDir,
    tokenizer,
    model,
    reason: tokenizer && model ? null : "model_cache_missing",
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
}) {
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
  const downloaded = await downloadPackage(client, ATLAS_JINA_MODEL.mlModelId);
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
    timeoutMs: 0,
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
