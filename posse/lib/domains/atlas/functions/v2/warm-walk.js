// @ts-check
//
// ATLAS v2 warm-walk helpers — the async repo file walk used by warm jobs,
// with the directory skip-set and the per-job path ceiling. Lifted out of
// ParseEngine; depends only on fs/path.

import fs from "fs";
import path from "path";
import { gitExecBufferAsync } from "../../../git/functions/utils.js";

/**
 * Full warms must be complete to publish an exact generation. Runtime is
 * bounded by the warm/conductor deadline, not by silently truncating paths.
 */
export const MAX_FULL_WARM_PATHS = Number.POSITIVE_INFINITY;

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
 * Typed disposition recorded when a walked entry is excluded from exact
 * source indexing because it is a symlink. Git proves only the committed link
 * text, so the dereferenced target can change while `git status` stays clean;
 * hashing that target would certify bytes the repository OID never proved.
 */
export const ATLAS_WARM_WALK_SYMLINK_SKIP_REASON = "symlink_skip";

/** Human-readable disposition message paired with the reason above. */
export const ATLAS_WARM_WALK_SYMLINK_SKIP_MESSAGE =
  "Symlink excluded from exact source indexing; Git proves the link text, not the dereferenced target";

/**
 * Single decision point shared by the Git-backed walk, the filesystem
 * fallback walk, and the per-path indexer, so all three return the same
 * disposition for the same entry.
 *
 * The argument only needs `lstat` semantics, which makes the symlink
 * disposition exercisable without symlink-creation privilege: pass an
 * `fs.Stats` from `fs.lstat`, an `fs.Dirent` from
 * `readdir({ withFileTypes: true })`, or an injected stub.
 *
 * @param {{ isFile?: () => boolean, isSymbolicLink?: () => boolean } | null | undefined} entry
 * @returns {{ indexable: boolean, skip: { reason: string, message: string } | null }}
 */
export function atlasWarmWalkEntryDisposition(entry) {
  if (typeof entry?.isSymbolicLink === "function" && entry.isSymbolicLink()) {
    return {
      indexable: false,
      skip: {
        reason: ATLAS_WARM_WALK_SYMLINK_SKIP_REASON,
        message: ATLAS_WARM_WALK_SYMLINK_SKIP_MESSAGE,
      },
    };
  }
  return {
    indexable: typeof entry?.isFile === "function" && entry.isFile(),
    skip: null,
  };
}

/**
 * Async variant used by warm jobs so a full-repo scan yields between
 * directory reads instead of monopolizing the event loop.
 *
 * @param {string} repoRoot
 * @param {(filename: string, relPath: string) => boolean} accept
 * @param {{ maxPaths?: number, onExcluded?: (skip: { repo_rel_path: string, reason: string, message: string }) => void }} [opts]
 * @returns {Promise<string[]>}
 */
export async function walkRepoFilesAsync(repoRoot, accept, opts = {}) {
  const maxPaths = Number.isInteger(opts.maxPaths) && /** @type {number} */ (opts.maxPaths) > 0
    ? /** @type {number} */ (opts.maxPaths)
    : Infinity;
  const onExcluded = typeof opts.onExcluded === "function" ? opts.onExcluded : null;
  /**
   * @param {string} relPath
   * @param {{ reason: string, message: string }} skip
   */
  const reportExcluded = (relPath, skip) => {
    if (!onExcluded) return;
    onExcluded({ repo_rel_path: relPath, reason: skip.reason, message: skip.message });
  };
  /** @type {string[]} */
  const out = [];
  // Git is the authoritative source manifest for exact warms. It includes
  // tracked source under generically named build directories (for example a
  // legitimate `test/.../target/` package) while still excluding untracked,
  // ignored build output. The filesystem walk remains the non-Git fallback.
  try {
    const manifest = await gitExecBufferAsync(
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      repoRoot,
      { maxBuffer: 64 * 1024 * 1024, timeoutMs: 10 * 60_000 },
    );
    const paths = Buffer.from(manifest || "").toString("utf8").split("\0").filter(Boolean)
      .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    for (const relPath of paths) {
      if (out.length >= maxPaths) break;
      const filename = path.posix.basename(relPath);
      if (!accept(filename, relPath)) continue;
      /** @type {fs.Stats | null} */
      let entry = null;
      try {
        // lstat, not stat: a tracked symlink must be dispositioned as a
        // symlink instead of silently resolving to its target's bytes.
        entry = await fs.promises.lstat(path.join(repoRoot, relPath));
      } catch {
        continue;
      }
      const disposition = atlasWarmWalkEntryDisposition(entry);
      if (disposition.skip) {
        reportExcluded(relPath, disposition.skip);
        continue;
      }
      if (!disposition.indexable) continue;
      out.push(relPath);
    }
    return out;
  } catch {
    // A non-Git directory still gets the historical bounded filesystem walk.
  }
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
      } else {
        const relPath = relDir ? `${relDir}/${name}` : name;
        if (!accept(name, relPath)) continue;
        // Dirent already carries lstat semantics, so this fallback reaches the
        // same symlink disposition as the Git-backed walk above.
        const disposition = atlasWarmWalkEntryDisposition(ent);
        if (disposition.skip) {
          reportExcluded(relPath, disposition.skip);
          continue;
        }
        if (!disposition.indexable) continue;
        out.push(relPath);
      }
    }
    return true;
  }
  await walk(repoRoot, "");
  return out;
}
