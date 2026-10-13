// @ts-check

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { embeddingsRoot } from "../runtime-paths.js";

async function durableAnnPair(modelDir, stagingDir, signal) {
  const indexPath = path.join(modelDir, "index.usearch");
  const manifestPath = path.join(modelDir, "index.usearch.json");
  const copyPath = path.join(stagingDir, "index.usearch");
  try {
    const manifestBytes = await fs.promises.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestBytes);
    const expected = String(manifest?.sha256 || "").toLowerCase();
    if (manifest?.durable !== true || !/^[0-9a-f]{64}$/u.test(expected)) return;
    await fs.promises.copyFile(indexPath, copyPath, fs.constants.COPYFILE_EXCL);
    // Validate the copy, not the source: the source can change during copy.
    const hash = crypto.createHash("sha256");
    let size = 0;
    for await (const chunk of fs.createReadStream(copyPath, { signal: signal || undefined })) {
      size += chunk.length;
      hash.update(chunk);
    }
    if (Number(manifest.size) !== size || hash.digest("hex") !== expected) {
      throw new Error("ANN checkpoint changed while seeding");
    }
    await fs.promises.writeFile(path.join(stagingDir, "index.usearch.json"), manifestBytes);
  } catch {
    await fs.promises.rm(copyPath, { force: true });
    signal?.throwIfAborted();
  }
}

/**
 * Seed an empty WI embedding store from the repository store. keys.db is
 * copied through SQLite's snapshot boundary; the ANN is copied only when its
 * durable manifest and sha256 prove it can be adopted without quarantine.
 * Existing WI model directories are never overwritten.
 */
export async function seedWorkItemEmbeddingStore({ mainRepoRoot, worktreeRoot, signal = null }) {
  signal?.throwIfAborted();
  if (!mainRepoRoot || !worktreeRoot || path.resolve(mainRepoRoot) === path.resolve(worktreeRoot)) {
    return { seeded: 0, skipped: "same_root" };
  }
  const sourceRoot = embeddingsRoot(mainRepoRoot);
  const targetRoot = embeddingsRoot(worktreeRoot);
  let entries;
  try { entries = await fs.promises.readdir(sourceRoot, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return { seeded: 0, skipped: "source_missing" };
    throw error;
  }
  await fs.promises.mkdir(targetRoot, { recursive: true });
  let seeded = 0;
  for (const dirent of entries) {
    signal?.throwIfAborted();
    if (!dirent.isDirectory()) continue;
    const sourceDir = path.join(sourceRoot, dirent.name);
    const targetDir = path.join(targetRoot, dirent.name);
    const sourceKeys = path.join(sourceDir, "keys.db");
    if (!fs.existsSync(sourceKeys) || fs.existsSync(targetDir)) continue;
    const stagingDir = await fs.promises.mkdtemp(path.join(targetRoot, ".seed-"));
    let source = null;
    try {
      source = new Database(sourceKeys, { readonly: true, fileMustExist: true, timeout: 0 });
      await source.backup(path.join(stagingDir, "keys.db"), { progress: () => {
        signal?.throwIfAborted();
        return 128;
      } });
      await durableAnnPair(sourceDir, stagingDir, signal);
      signal?.throwIfAborted();
      // Publish a complete model in one rename. A concurrent completed seed
      // wins; never delete a directory another caller owns during cleanup.
      if (fs.existsSync(targetDir)) continue;
      try { await fs.promises.rename(stagingDir, targetDir); }
      catch (error) {
        if (["EEXIST", "ENOTEMPTY"].includes(error.code)) continue;
        throw error;
      }
      seeded += 1;
    } finally {
      try { source?.close(); } catch { /* best effort */ }
      await fs.promises.rm(stagingDir, { recursive: true, force: true });
    }
  }
  return { seeded, skipped: seeded > 0 ? null : "already_seeded" };
}
