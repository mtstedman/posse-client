// @ts-check

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { embeddingsRoot } from "../runtime-paths.js";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sqliteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function durableAnnPair(modelDir) {
  const indexPath = path.join(modelDir, "index.usearch");
  const manifestPath = path.join(modelDir, "index.usearch.json");
  if (!fs.existsSync(indexPath) || !fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const expected = String(manifest?.sha256 || "").toLowerCase();
    if (manifest?.durable !== true || !/^[0-9a-f]{64}$/u.test(expected)) return null;
    if (Number(manifest?.size) !== fs.statSync(indexPath).size) return null;
    if (sha256File(indexPath) !== expected) return null;
    return { indexPath, manifestPath };
  } catch {
    return null;
  }
}

/**
 * Seed an empty WI embedding store from the repository store. keys.db is
 * copied through SQLite's snapshot boundary; the ANN is copied only when its
 * durable manifest and sha256 prove it can be adopted without quarantine.
 * Existing WI model directories are never overwritten.
 */
export function seedWorkItemEmbeddingStore({ mainRepoRoot, worktreeRoot }) {
  const sourceRoot = embeddingsRoot(mainRepoRoot);
  const targetRoot = embeddingsRoot(worktreeRoot);
  if (!mainRepoRoot || !worktreeRoot || path.resolve(mainRepoRoot) === path.resolve(worktreeRoot)) {
    return { seeded: 0, skipped: "same_root" };
  }
  if (!fs.existsSync(sourceRoot)) return { seeded: 0, skipped: "source_missing" };
  fs.mkdirSync(targetRoot, { recursive: true });
  let seeded = 0;
  for (const dirent of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const sourceDir = path.join(sourceRoot, dirent.name);
    const targetDir = path.join(targetRoot, dirent.name);
    const sourceKeys = path.join(sourceDir, "keys.db");
    const targetKeys = path.join(targetDir, "keys.db");
    if (!fs.existsSync(sourceKeys) || fs.existsSync(targetDir)) continue;
    fs.mkdirSync(targetDir, { recursive: true });
    let source = null;
    try {
      source = new Database(sourceKeys, { readonly: true, fileMustExist: true });
      source.pragma("busy_timeout = 5000");
      source.exec(`VACUUM INTO ${sqliteLiteral(targetKeys)}`);
      const ann = durableAnnPair(sourceDir);
      if (ann) {
        fs.copyFileSync(ann.indexPath, path.join(targetDir, "index.usearch"), fs.constants.COPYFILE_EXCL);
        fs.copyFileSync(ann.manifestPath, path.join(targetDir, "index.usearch.json"), fs.constants.COPYFILE_EXCL);
      }
      seeded += 1;
    } catch (error) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    } finally {
      try { source?.close(); } catch { /* best effort */ }
    }
  }
  return { seeded, skipped: seeded > 0 ? null : "already_seeded" };
}

