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
      return failure(
        "file_not_found",
        `Could not read ${relPath}: the path does not exist in the active checkout`,
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
    return failure("not_a_file", `Could not read ${relPath}: the path is not a regular file`, "rejected", "not_a_file");
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
