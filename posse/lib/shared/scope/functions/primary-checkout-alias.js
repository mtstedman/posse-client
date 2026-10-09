import path from "node:path";

import { primaryCheckoutFor } from "../../../domains/verification/functions/prerequisite-adapters.js";

// Top-level entries of the primary checkout that are not repository content:
// git metadata, Posse runtime resources and sibling work-item worktrees. A
// path into one of them keeps its normal denial instead of being aliased.
const UNALIASED_PRIMARY_ENTRIES = new Set([".git", ".posse", ".posse-worktrees", ".posse-test-suites"]);

/**
 * Map an absolute path inside the primary checkout of a linked git worktree to
 * the same repo path inside that worktree. Agents running in a work-item
 * worktree or a detached read-only checkout often address files by the
 * project's absolute root; this resolves them against the checkout they run
 * in, deterministically. Returns `{ aliased, relative }`, or null when `cwd`
 * is not a linked worktree root or `absPath` is relative, outside the primary
 * checkout, or under a non-content entry.
 */
export function primaryCheckoutAlias(cwd, absPath) {
  if (typeof absPath !== "string" || !path.isAbsolute(absPath)) return null;
  const primary = primaryCheckoutFor(cwd);
  if (!primary) return null;
  const rel = path.relative(path.resolve(primary), path.resolve(absPath));
  if (rel === "") return { aliased: path.resolve(cwd), relative: "." };
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const relative = rel.split(path.sep).join("/");
  if (UNALIASED_PRIMARY_ENTRIES.has(relative.split("/")[0])) return null;
  return { aliased: path.join(path.resolve(cwd), rel), relative };
}
