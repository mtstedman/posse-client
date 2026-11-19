// @ts-check
//
// Version identity for the HEAD-keyed embedded Atlas read caches. HEAD alone
// misses uncommitted edits made outside Posse's write tools (a shell
// formatter, codegen, a provider-native patch), which fire no reindex, so a
// dirty tree adds a fingerprint of its status records and of each dirty
// path's stat. One porcelain-v2 status call yields both HEAD and the dirty
// set. Anything unproven returns null, and callers then skip their caches.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gitStatusPorcelainAsync } from "../../git/functions/utils.js";
import { isPosseRuntimePath } from "../../runtime/functions/ignore.js";

const STATUS_ARGS = ["--porcelain=v2", "--branch", "-z", "--untracked-files=all"];
const STATUS_TIMEOUT_MS = 5000;
const DIRTY_PATH_LIMIT = 10_000;

/**
 * @param {string | null | undefined} cwd
 * @param {{ statusPorcelain?: (cwd: string) => Promise<unknown> }} [deps]
 * @returns {Promise<string | null>}
 */
export async function atlasTreeVersionId(cwd, {
  statusPorcelain = (dir) => gitStatusPorcelainAsync(dir, STATUS_ARGS, { timeoutMs: STATUS_TIMEOUT_MS }),
} = {}) {
  if (!cwd) return null;
  let raw;
  try {
    raw = String(await statusPorcelain(cwd) ?? "");
  } catch {
    return null;
  }
  const status = parseStatusV2(raw);
  if (!status?.head) return null;
  if (status.paths.length === 0) return `head:${status.head}`;
  if (status.paths.length > DIRTY_PATH_LIMIT) return null;
  // Porcelain paths are repository-root relative; a nested project's cwd is not the root.
  const root = repositoryRoot(cwd);
  if (!root) return null;
  const hash = crypto.createHash("sha256").update("atlas-tree-v1");
  for (const record of status.records) hash.update(`\0${record}`);
  for (const relPath of status.paths) {
    const signature = pathSignature(path.resolve(root, relPath));
    if (signature == null) return null;
    hash.update(`\0${relPath}\0${signature}`);
  }
  return `head:${status.head}|dirty:${hash.digest("hex").slice(0, 32)}`;
}

/**
 * @param {string} raw
 * @returns {{ head: string | null, records: string[], paths: string[] } | null}
 */
function parseStatusV2(raw) {
  const fields = raw.split("\0");
  let head = null;
  const records = [];
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length).trim();
      head = oid === "(initial)" ? "initial" : oid;
      continue;
    }
    if (record.startsWith("#")) continue;
    let filePath;
    let originalPath = null;
    switch (record[0]) {
      case "1": filePath = record.split(" ").slice(8).join(" "); break;
      case "2": filePath = record.split(" ").slice(9).join(" "); originalPath = fields[++index] || null; break;
      case "u": filePath = record.split(" ").slice(10).join(" "); break;
      case "?":
      case "!": filePath = record.slice(2); break;
      default: return null;
    }
    if (!filePath) return null;
    // Posse writes its own state (.posse/ logs, Atlas views) on every call;
    // Atlas never reads it as source.
    if (isPosseRuntimePath(filePath) && (originalPath == null || isPosseRuntimePath(originalPath))) continue;
    records.push(originalPath == null ? record : `${record}\0${originalPath}`);
    paths.push(filePath);
    if (originalPath != null) paths.push(originalPath);
  }
  return { head, records, paths };
}

function repositoryRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function pathSignature(absPath) {
  try {
    const stat = fs.lstatSync(absPath, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "missing" : null;
  }
}
