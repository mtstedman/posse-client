// @ts-check

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  defaultNativeBinRoot,
  nativeArtifactVersionRoot,
  validNativeArtifactVersion,
} from "./artifact-layout.js";

const SELECTION_FILE = ".issued-version";
const MAX_SELECTION_BYTES = 128;

/** @param {{ binRoot?: string, name: string }} args */
export function nativeArtifactSelectionPath({
  binRoot = defaultNativeBinRoot(),
  name,
}) {
  const versionRoot = nativeArtifactVersionRoot({ binRoot, name, version: "selection" });
  return versionRoot ? path.join(path.dirname(versionRoot), SELECTION_FILE) : null;
}

/**
 * Read the last server-issued version activated at an installation boundary.
 * The marker mtime is also the boundary for a subsequently rebuilt flat
 * development binary: only a build newer than the marker remains an override.
 * @param {{ binRoot?: string, name: string }} args
 */
export function readNativeArtifactSelectionSync({
  binRoot = defaultNativeBinRoot(),
  name,
}) {
  const selectionPath = nativeArtifactSelectionPath({ binRoot, name });
  if (!selectionPath) return null;
  try {
    const stat = fs.statSync(selectionPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SELECTION_BYTES) return null;
    const version = validNativeArtifactVersion(fs.readFileSync(selectionPath, "utf8"));
    if (!version) return null;
    return Object.freeze({ version, selectedAtMs: stat.mtimeMs, path: selectionPath });
  } catch {
    return null;
  }
}

/**
 * Atomically remember a verified server-issued artifact for future processes.
 * @param {{ binRoot?: string, name: string, version: string }} args
 */
export async function recordNativeArtifactSelection({
  binRoot = defaultNativeBinRoot(),
  name,
  version,
}) {
  const normalizedVersion = validNativeArtifactVersion(version);
  const selectionPath = nativeArtifactSelectionPath({ binRoot, name });
  if (!normalizedVersion || !selectionPath) {
    throw new TypeError("A valid native artifact name and version are required");
  }
  const directory = path.dirname(selectionPath);
  const temporaryPath = `${selectionPath}.${randomUUID()}.part`;
  await fsp.mkdir(directory, { recursive: true });
  try {
    const handle = await fsp.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${normalizedVersion}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporaryPath, selectionPath);
    await syncDirectory(directory);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return readNativeArtifactSelectionSync({ binRoot, name });
}

async function syncDirectory(directory) {
  let handle = null;
  try {
    handle = await fsp.open(directory, "r");
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on Windows; the marker itself was synced.
  } finally {
    await handle?.close().catch(() => {});
  }
}
