// @ts-check
//
// ATLAS v2 warm-walk helpers — the async repo file walk used by warm jobs,
// with the directory skip-set and the per-job path ceiling. Lifted out of
// ParseEngine; depends only on fs/path.

import fs from "fs";
import path from "path";

/**
 * Upper bound on paths a single `main-full` warm job will index. Keeps
 * one job from blowing the per-job runtime budget when pointed at a
 * very large repo. main-full is admin-triggered and rare; an operator
 * can chain a few jobs if a repo legitimately exceeds this.
 */
export const MAX_FULL_WARM_PATHS = 5000;

const WALK_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".posse",
  ".posse-worktrees",
  ".posse-test-suites",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "build",
  "dist",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
]);

/**
 * Async variant used by warm jobs so a full-repo scan yields between
 * directory reads instead of monopolizing the event loop.
 *
 * @param {string} repoRoot
 * @param {(filename: string, relPath: string) => boolean} accept
 * @param {{ maxPaths?: number }} [opts]
 * @returns {Promise<string[]>}
 */
export async function walkRepoFilesAsync(repoRoot, accept, opts = {}) {
  const maxPaths = Number.isInteger(opts.maxPaths) && /** @type {number} */ (opts.maxPaths) > 0
    ? /** @type {number} */ (opts.maxPaths)
    : Infinity;
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} absDir
   * @param {string} relDir
   * @returns {Promise<boolean>}
   */
  async function walk(absDir, relDir) {
    if (out.length >= maxPaths) return false;
    /** @type {fs.Dirent[]} */
    let entries;
    try { entries = await fs.promises.readdir(absDir, { withFileTypes: true }); }
    catch { return true; }
    for (const ent of entries) {
      if (out.length >= maxPaths) return false;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (WALK_SKIP_DIRS.has(name)) continue;
        if (name.startsWith(".") && !relDir) continue;
        const childRel = relDir ? `${relDir}/${name}` : name;
        if (!await walk(path.join(absDir, name), childRel)) return false;
      } else if (ent.isFile()) {
        const relPath = relDir ? `${relDir}/${name}` : name;
        if (!accept(name, relPath)) continue;
        out.push(relPath);
      }
    }
    return true;
  }
  await walk(repoRoot, "");
  return out;
}
