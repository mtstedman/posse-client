import fs from "node:fs";
import path from "node:path";

import { gitExecAsync } from "../../git/functions/utils.js";

function normalizePath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

async function existsAtCommit(cwd, commit, relPath) {
  try {
    await gitExecAsync(["cat-file", "-e", `${commit}:${relPath}`], cwd);
    return true;
  } catch {
    return false;
  }
}

async function removeAbsentPath(cwd, relPath) {
  try {
    await gitExecAsync(["rm", "--cached", "--force", "--ignore-unmatch", "--", relPath], cwd);
  } catch {
    // An untracked placeholder has no index entry; the filesystem removal
    // below is still the required tree projection.
  }
  const target = path.resolve(cwd, ...relPath.split("/"));
  const root = path.resolve(cwd);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe lineage path: ${relPath}`);
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) throw new Error(`lineage path is a directory: ${relPath}`);
    await fs.promises.unlink(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function projectPaths(cwd, commit, paths) {
  const present = [];
  const absent = [];
  for (const relPath of paths) {
    if (await existsAtCommit(cwd, commit, relPath)) present.push(relPath);
    else absent.push(relPath);
  }
  if (present.length > 0) {
    await gitExecAsync(["restore", "--source", commit, "--staged", "--worktree", "--", ...present], cwd);
  }
  for (const relPath of absent) await removeAbsentPath(cwd, relPath);
}

/**
 * Run against the current tree with only `paths` restored to `baseCommit`.
 * HEAD never moves and every other path—including concurrent sibling work—is
 * untouched. The original path projection is restored even when `run` fails.
 */
export async function withLineagePathsRestored({ cwd, baseCommit, paths = [], run } = {}) {
  if (!cwd || !baseCommit || typeof run !== "function") throw new Error("lineage tree projection requires cwd, baseCommit, and run");
  const normalized = [...new Set(paths.map(normalizePath).filter(Boolean))].sort();
  if (normalized.length === 0) return run({ baseCommit, paths: [] });
  const originalCommit = String(await gitExecAsync(["rev-parse", "HEAD"], cwd) || "").trim();
  await gitExecAsync(["cat-file", "-e", `${baseCommit}^{commit}`], cwd);
  let runError = null;
  let result;
  try {
    await projectPaths(cwd, baseCommit, normalized);
    result = await run({ baseCommit, paths: normalized });
  } catch (error) {
    runError = error;
  }
  try {
    await projectPaths(cwd, originalCommit, normalized);
    const afterCommit = String(await gitExecAsync(["rev-parse", "HEAD"], cwd) || "").trim();
    if (afterCommit !== originalCommit) throw new Error("lineage projection changed Git HEAD");
  } catch (restoreError) {
    if (!runError) throw restoreError;
    runError.restore_error = restoreError?.message || String(restoreError);
  }
  if (runError) throw runError;
  return result;
}
