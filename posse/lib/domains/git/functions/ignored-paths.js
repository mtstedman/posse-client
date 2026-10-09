// lib/domains/git/functions/ignored-paths.js
//
// Which declared repository paths the repository's ignore rules exclude. Git
// never commits an untracked ignored path (scoped commit staging skips it), so
// a reviewer or assessor that finds one in a job's scope must be told that its
// workspace copy is local, uncommitted state and not part of the change.
// Advisory: when git cannot answer, nothing is reported.

import { gitExecAsync } from "./utils.js";

const CHECK_IGNORE_TIMEOUT_MS = 10_000;

function repoRelativePath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/**
 * The untracked paths among `paths` that the repository ignores, each with the
 * rule that matched. Tracked files are never reported: git commits changes to
 * them whatever the ignore rules say. Absolute and parent-relative paths are
 * skipped.
 *
 * @param {string} cwd repository working directory the paths are relative to
 * @param {string[]} paths repository-relative paths
 * @param {{ git?: typeof gitExecAsync }} [options]
 * @returns {Promise<Array<{ path: string, source: string }>>} sorted by path; source is `<ignore file>:<line>`
 */
export async function listIgnoredRepoPaths(cwd, paths, { git = gitExecAsync } = {}) {
  const candidates = [...new Set((Array.isArray(paths) ? paths : []).map(repoRelativePath).filter(Boolean))];
  if (!cwd || candidates.length === 0) return [];
  let output;
  try {
    output = await git(["check-ignore", "-v", "-z", "--stdin"], cwd, {
      input: `${candidates.join("\0")}\0`,
      trim: false,
      timeoutMs: CHECK_IGNORE_TIMEOUT_MS,
    });
  } catch {
    // Exit 1: no path is ignored. Any other failure leaves the paths unmarked.
    return [];
  }
  // -v -z: "<source>\0<line>\0<pattern>\0<path>\0" per matched path.
  const fields = String(output || "").split("\0");
  const ignored = new Map();
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [source, line, pattern, matched] = fields.slice(index, index + 4);
    // -v also reports a negated rule ("!pattern"), which re-includes the path.
    if (!source || String(pattern).startsWith("!")) continue;
    const repoPath = repoRelativePath(matched);
    if (repoPath && !ignored.has(repoPath)) ignored.set(repoPath, { path: repoPath, source: `${source}:${line}` });
  }
  return [...ignored.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
