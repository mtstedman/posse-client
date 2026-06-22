import fs from "fs";
import path from "path";

import {
  buildManifest,
  getArtifactProtocol,
  isArtifactMode,
  validateManifestAgainstContract,
} from "../../artifacts/functions/index.js";
import { isInsideRoot } from "../../runtime/functions/fs-safety.js";

export function planArtifactReuse(task = {}, projectDir = ".") {
  const taskMode = task.task_mode || "code";
  const outputRoot = task.output_root || null;
  const createFiles = Array.isArray(task.files_to_create) ? task.files_to_create.filter(Boolean) : [];
  if (!outputRoot || !isArtifactMode(taskMode) || createFiles.length === 0) return null;

  const absOutputRoot = path.resolve(projectDir, outputRoot);
  if (!fs.existsSync(absOutputRoot)) return null;

  const manifest = buildManifest(absOutputRoot, absOutputRoot);
  if (!manifest || manifest.count === 0) return null;

  const protocol = getArtifactProtocol(taskMode) || {};
  const validation = protocol.output_validation || {};
  const allowedFormats = Array.isArray(protocol.allowed_formats) ? new Set(protocol.allowed_formats) : null;
  const minBytes = Number(validation.min_bytes || 0);
  const manifestMap = new Map(manifest.files.map((file) => [file.path, file]));

  const expected = [];
  const seen = new Set();
  for (const createFile of createFiles) {
    const absCreateFile = path.resolve(projectDir, createFile);
    const relPath = path.relative(absOutputRoot, absCreateFile).replace(/\\/g, "/");
    if (!isInsideRoot(absCreateFile, absOutputRoot, { allowEqual: false })) continue;
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    expected.push({ createFile, relPath });
  }
  if (expected.length === 0) return null;

  const reusableFiles = [];
  const missingCreateFiles = [];
  for (const expectedFile of expected) {
    const existing = manifestMap.get(expectedFile.relPath);
    if (!existing) {
      missingCreateFiles.push(expectedFile.createFile);
      continue;
    }
    const formatOk = !allowedFormats || allowedFormats.has(existing.ext);
    const sizeOk = existing.size >= minBytes;
    if (formatOk && sizeOk) {
      reusableFiles.push(existing);
    } else {
      missingCreateFiles.push(expectedFile.createFile);
    }
  }
  if (reusableFiles.length === 0) return null;

  const reusableManifest = {
    files: reusableFiles,
    totalSize: reusableFiles.reduce((sum, file) => sum + (file.size || 0), 0),
    count: reusableFiles.length,
  };
  const contractResult = validateManifestAgainstContract(reusableManifest, taskMode);

  return {
    manifest,
    reusableManifest,
    reusableFiles,
    missingCreateFiles,
    allExpectedReusable: missingCreateFiles.length === 0,
    validReusableOutputs: !!contractResult.valid,
    warnings: contractResult.warnings || [],
  };
}
