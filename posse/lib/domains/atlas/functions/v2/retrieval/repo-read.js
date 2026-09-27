// @ts-check

import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{
 *   ok: false,
 *   code: string,
 *   message: string,
 *   details: {
 *     status: "failed" | "rejected",
 *     retryable: boolean,
 *     path: string,
 *     targetSource: "file" | "symbolId",
 *     reason: string,
 *   },
 * }} RepoFileReadFailure
 */

/**
 * Read one canonical repository-relative file while preserving a sanitized
 * failure classification for callers that need actionable tool errors.
 *
 * @param {string | undefined} repoRoot
 * @param {string} repoRelPath
 * @param {{ targetSource?: "file" | "symbolId" }} [options]
 * @returns {{ ok: true, content: string } | { ok: false, code: string, message: string, details: Record<string, unknown> }}
 */
export function readRepoFileResult(repoRoot, repoRelPath, { targetSource = "file" } = {}) {
  const relPath = String(repoRelPath || "");
  const indexedTarget = targetSource === "symbolId";
  /** @type {(code: string, message: string, status: "failed" | "rejected", reason: string, retryable?: boolean) => RepoFileReadFailure} */
  const failure = (code, message, status, reason, retryable = false) => ({
    ok: false,
    code,
    message,
    details: {
      status,
      retryable,
      path: relPath,
      targetSource,
      reason,
    },
  });

  if (!repoRoot) {
    return failure(
      "repo_root_unavailable",
      `Could not read ${relPath}: the active repository root is unavailable`,
      "failed",
      "repo_root_unavailable",
    );
  }

  const root = path.resolve(repoRoot);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return failure(
      "repo_root_unavailable",
      `Could not read ${relPath}: the active repository root is unavailable`,
      "failed",
      "repo_root_unavailable",
    );
  }

  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return failure("invalid_path", `Could not read ${relPath}: path leaves the active repository`, "rejected", "path_outside_repo");
  }

  let realAbs;
  try {
    realAbs = fs.realpathSync(abs);
  } catch (error) {
    const notFound = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    if (notFound && indexedTarget) {
      return failure(
        "indexed_file_missing",
        `Could not read indexed path ${relPath}: it is missing from the active checkout`,
        "failed",
        "index_drift",
      );
    }
    if (notFound) {
      const sameName = filesNamedLike(root, relPath);
      return failure(
        "file_not_found",
        `Could not read ${relPath}: the path does not exist in the active checkout${sameName.length > 0 ? `. Files with that name: ${sameName.join(", ")}` : ""}`,
        "rejected",
        "not_found",
      );
    }
    return ioFailure(error, failure, relPath);
  }

  if (!realAbs.startsWith(realRoot + path.sep) && realAbs !== realRoot) {
    return failure("invalid_path", `Could not read ${relPath}: resolved path leaves the active repository`, "rejected", "symlink_outside_repo");
  }

  let stat;
  try {
    stat = fs.statSync(realAbs);
  } catch (error) {
    return ioFailure(error, failure, relPath);
  }
  if (!stat.isFile()) {
    return failure(
      "not_a_file",
      stat.isDirectory()
        ? `Could not read ${relPath}: it is a directory; this read takes one file path`
        : `Could not read ${relPath}: the path is not a regular file`,
      "rejected",
      "not_a_file",
    );
  }

  try {
    return { ok: true, content: fs.readFileSync(realAbs, "utf8") };
  } catch (error) {
    return ioFailure(error, failure, relPath);
  }
}

function ioFailure(error, failure, relPath) {
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return failure("permission_denied", `Could not read ${relPath}: permission denied`, "failed", "permission_denied");
  }
  return failure("file_read_failed", `Could not read ${relPath}: repository file I/O failed`, "failed", String(error?.code || "io_error").toLowerCase());
}

const SAME_NAME_WALK_LIMIT = 40_000;
const SAME_NAME_SKIP_DIRS = new Set([".git", "node_modules", ".posse", "target", "vendor", "dist", "build", "__pycache__"]);

// A misremembered directory (packages/common/helpers/x.ts for
// packages/core/helpers/x.ts) otherwise costs a search call to recover. List
// repository files that share the missing path's file name, bounded.
function filesNamedLike(root, relPath) {
  const wanted = path.basename(String(relPath || ""));
  if (!wanted) return [];
  const found = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && found.length < 50 && visited < SAME_NAME_WALK_LIMIT) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.isDirectory()) {
        if (!SAME_NAME_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name === wanted) {
        found.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join("/"));
        if (found.length >= 50) break;
      }
    }
  }
  const requested = String(relPath).split("/").slice(0, -1);
  const shared = (candidate) => {
    const parts = candidate.split("/").slice(0, -1);
    let count = 0;
    for (const part of parts) if (requested.includes(part)) count += 1;
    return count;
  };
  return found
    .map((candidate) => ({ candidate, shared: shared(candidate) }))
    .filter((row) => row.shared > 0 || requested.length === 0)
    .sort((a, b) => b.shared - a.shared || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((row) => row.candidate);
}
