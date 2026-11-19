// Path addressing for a project nested inside its git repository (Posse's own
// repository is laid out this way).
//
// git reports names from `diff`, `diff-tree`, `status --porcelain`,
// `ls-tree --full-name` and the `<rev>:<path>` syntax relative to the
// repository root whatever the cwd, while pathspecs, `ls-tree` without
// `--full-name` and `ls-files` are relative to the cwd. Convert a name to the
// space its consumer needs at the point it is read, and address git with
// `:(top,literal)` pathspecs. Never strip a prefix "if present": with project
// `backend` and a package `backend/backend/`, `backend/x.py` is a valid name
// in both spaces and means two different files.

import path from "path";

function slashed(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

/** "" for the repository root, otherwise the project prefix ending in "/". */
export function normalizeGitPrefix(prefix) {
  const trimmed = slashed(prefix).trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed && trimmed !== "." ? `${trimmed}/` : "";
}

/** The cwd's prefix inside its repository (`git rev-parse --show-prefix`). */
export function gitProjectPrefix(exec, cwd) {
  return normalizeGitPrefix(String(exec(["rev-parse", "--show-prefix"], cwd, { trim: false }) ?? "").replace(/\r?\n$/, ""));
}

/** The root of the git worktree that contains `cwd`. */
export function gitWorktreeRoot(exec, cwd) {
  const root = String(exec(["rev-parse", "--show-toplevel"], cwd) ?? "").trim();
  if (!root) throw new Error(`git did not report a worktree root for ${cwd}`);
  return path.resolve(root);
}

/**
 * A repository-relative name as seen from the project directory: the prefix
 * removed, or a `../` path for a name outside the project.
 */
export function repoPathToProjectPath(repoPath, prefix) {
  const name = slashed(repoPath).replace(/^\/+/, "");
  const normalizedPrefix = normalizeGitPrefix(prefix);
  if (!name || !normalizedPrefix) return name;
  if (name.startsWith(normalizedPrefix)) return name.slice(normalizedPrefix.length);
  return path.posix.relative(normalizedPrefix.slice(0, -1), name);
}

/** A project-relative name (possibly `../`) as a repository-relative name. */
export function projectPathToRepoPath(projectPath, prefix) {
  const name = slashed(projectPath).replace(/^\.\//, "");
  const normalizedPrefix = normalizeGitPrefix(prefix);
  if (!name || !normalizedPrefix) return name;
  return path.posix.normalize(`${normalizedPrefix}${name}`);
}

/** A pathspec naming exactly one repository-relative path, from any cwd. */
export function topLiteralPathspec(repoPath) {
  return `:(top,literal)${repoPath}`;
}

/**
 * Names from a git listing (`diff --name-only`, `ls-files`, `ls-tree
 * --name-only`, `diff-tree --name-only`), NUL-separated so no name is
 * C-quoted. `args[0]` is the subcommand; `-z` is added after it.
 */
export function gitNameList(exec, cwd, args, options = {}) {
  const [subcommand, ...rest] = args;
  const output = exec(["-c", "core.quotePath=false", subcommand, "-z", ...rest], cwd, { ...options, trim: false });
  return String(output ?? "").split("\0").filter(Boolean);
}
