// @ts-check
//
// One generation boundary for rebuildable ATLAS data. The ledger schema
// version is the cold-boot marker; when it changes, every cache derived from
// that ledger is removed before the full warm starts. Durable memory and
// account/settings data are deliberately outside this boundary.

import fs from "node:fs";
import path from "node:path";

import {
  atlasDir,
  embeddingsRoot,
  ledgerDbPath,
  slicesDbPath,
  viewsDir,
} from "./runtime-paths.js";
import { invalidateStorageCacheNativeAsync } from "./native/storage.js";
import { removeSqliteFile } from "./view-health.js";

const SQLITE_SUFFIXES = Object.freeze(["", "-wal", "-shm", "-journal"]);

/**
 * @param {string} atlasRoot
 * @param {string} targetPath
 */
function assertAtlasChild(atlasRoot, targetPath) {
  const relative = path.relative(atlasRoot, targetPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to reset ATLAS path outside ${atlasRoot}: ${targetPath}`);
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function listViewDatabases(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = /** @type {string} */ (pending.pop());
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name.endsWith(".db")) {
        found.push(candidate);
      }
    }
  }
  return found;
}

/**
 * @param {string} targetPath
 * @returns {boolean}
 */
function sqliteFamilyExists(targetPath) {
  return SQLITE_SUFFIXES.some((suffix) => fs.existsSync(`${targetPath}${suffix}`));
}

/**
 * Delete every rebuildable ATLAS database/cache for one repo. The ledger is
 * removed last: if closing a handle or deleting another cache fails, its old
 * schema marker remains in place so the next cold boot retries the reset.
 *
 * Preserved by construction: memory.db, SCIP staging, model caches, settings,
 * and every path outside <repo>/.posse/atlas.
 *
 * @param {{ repoRoot: string }} args
 * @returns {Promise<{ atlasRoot: string, removed: string[] }>}
 */
export async function resetAtlasRebuildableData({ repoRoot }) {
  const resolvedRepoRoot = path.resolve(String(repoRoot || ""));
  if (!repoRoot || !resolvedRepoRoot) throw new Error("ATLAS data reset requires repoRoot");

  const atlasRoot = path.resolve(atlasDir(resolvedRepoRoot));
  const ledgerPath = path.resolve(ledgerDbPath(resolvedRepoRoot));
  const slicePath = path.resolve(slicesDbPath(resolvedRepoRoot));
  const viewRoot = path.resolve(viewsDir(resolvedRepoRoot));
  const embeddingRoot = path.resolve(embeddingsRoot(resolvedRepoRoot));
  for (const targetPath of [ledgerPath, slicePath, viewRoot, embeddingRoot]) {
    assertAtlasChild(atlasRoot, targetPath);
  }

  const viewPaths = listViewDatabases(viewRoot);
  const { closeAllPooledEmbeddingResources } = await import("./embeddings/resources.js");
  await closeAllPooledEmbeddingResources();
  await invalidateStorageCacheNativeAsync([ledgerPath, ...viewPaths]);

  const removed = [];
  const removeDirectory = (targetPath) => {
    assertAtlasChild(atlasRoot, targetPath);
    if (!fs.existsSync(targetPath)) return;
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (fs.existsSync(targetPath)) throw new Error(`ATLAS reset path still exists: ${targetPath}`);
    removed.push(targetPath);
  };
  const removeSqlite = (targetPath) => {
    assertAtlasChild(atlasRoot, targetPath);
    const existed = sqliteFamilyExists(targetPath);
    removeSqliteFile(targetPath);
    const remaining = SQLITE_SUFFIXES.find((suffix) => fs.existsSync(`${targetPath}${suffix}`));
    if (remaining != null) throw new Error(`ATLAS reset path still exists: ${targetPath}${remaining}`);
    if (existed) removed.push(targetPath);
  };

  removeDirectory(viewRoot);
  removeSqlite(slicePath);
  removeDirectory(embeddingRoot);
  removeSqlite(ledgerPath);

  return { atlasRoot, removed };
}
