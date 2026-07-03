import fs from "fs";
import path from "path";
import { getAtlasIntegrationConfig } from "./config.js";
import { deriveRepoId, isPathWithin, normalizeAbsolutePath, pathsEqual } from "./shared.js";
import { gitExec, gitExecAsync } from "../../../git/functions/utils.js";

export const _gitRepoInfoCache = new Map();

export function resolveGitRepoInfoFromCwd(cwd) {
  const normalized = normalizeAbsolutePath(cwd);
  if (!normalized) return null;
  if (_gitRepoInfoCache.has(normalized)) return _gitRepoInfoCache.get(normalized);
  let result = null;
  try {
    if (fs.existsSync(normalized)) {
      let commonStdout = "";
      let gitDirStdout = "";
      let commonOk = false;
      let gitDirOk = false;
      try {
        commonStdout = gitExec(["rev-parse", "--path-format=absolute", "--git-common-dir"], normalized, { timeoutMs: 5000 });
        commonOk = true;
      } catch { /* not a git repo */ }
      try {
        gitDirStdout = gitExec(["rev-parse", "--path-format=absolute", "--git-dir"], normalized, { timeoutMs: 5000 });
        gitDirOk = true;
      } catch { /* not a git repo */ }
      result = gitRepoInfoFromRevParse(
        commonStdout,
        gitDirStdout,
        commonOk,
        gitDirOk,
      );
    }
  } catch {
    // git not available or not a repo — leave result null
  }
  _gitRepoInfoCache.set(normalized, result);
  return result;
}

function gitRepoInfoFromRevParse(commonStdout, gitDirStdout, commonOk, gitDirOk) {
  if (!commonOk) return null;
  const commonDir = String(commonStdout || "").trim();
  if (!commonDir) return null;
  const parent = path.dirname(commonDir);
  const mainRepoPath = parent ? normalizeAbsolutePath(parent) : null;
  const gitDir = gitDirOk
    ? normalizeAbsolutePath(String(gitDirStdout || "").trim())
    : null;
  const worktreeMetaRoot = mainRepoPath
    ? normalizeAbsolutePath(path.join(mainRepoPath, ".git", "worktrees"))
    : null;
  const isLinkedWorktree = !!(
    gitDir &&
    worktreeMetaRoot &&
    (pathsEqual(gitDir, worktreeMetaRoot) || isPathWithin(gitDir, worktreeMetaRoot))
  );
  return { mainRepoPath, gitDir, isLinkedWorktree };
}

function gitRevParseAsync(args, cwd, { signal = null } = {}) {
  return gitExecAsync(["rev-parse", ...args], cwd, { signal, timeoutMs: 5000 })
    .then((stdout) => ({ ok: true, stdout: String(stdout || "") }))
    .catch(() => ({ ok: false, stdout: "" }));
}

export async function resolveGitRepoInfoFromCwdAsync(cwd, { signal = null } = {}) {
  const normalized = normalizeAbsolutePath(cwd);
  if (!normalized) return null;
  if (_gitRepoInfoCache.has(normalized)) return _gitRepoInfoCache.get(normalized);
  let result = null;
  try {
    await fs.promises.access(normalized);
    const [commonOut, gitDirOut] = await Promise.all([
      gitRevParseAsync(["--path-format=absolute", "--git-common-dir"], normalized, { signal }),
      gitRevParseAsync(["--path-format=absolute", "--git-dir"], normalized, { signal }),
    ]);
    result = gitRepoInfoFromRevParse(commonOut.stdout, gitDirOut.stdout, commonOut.ok, gitDirOut.ok);
  } catch {
    result = null;
  }
  _gitRepoInfoCache.set(normalized, result);
  return result;
}

export function resolveAtlasRepoTarget({
  cwd = null,
  config = getAtlasIntegrationConfig(),
} = {}) {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  const requestedRepoPath = normalizeAbsolutePath(config.requestedRepoPath);
  const requestedGitInfo = requestedRepoPath ? resolveGitRepoInfoFromCwd(requestedRepoPath) : null;
  const requestedRepoTarget = requestedGitInfo?.isLinkedWorktree && requestedGitInfo?.mainRepoPath
    ? requestedGitInfo.mainRepoPath
    : requestedRepoPath;
  const cwdGitInfo = cwd ? resolveGitRepoInfoFromCwd(cwd) : null;
  const cwdMainRepoPath = cwdGitInfo?.mainRepoPath || null;

  // When the project sits as a subdir inside a larger git repo (sibling
  // projects under one umbrella repo, e.g. C:/dev/parent/{mike,gov-notice,…}
  // where parent itself is a git repo), the umbrella is NOT the ATLAS repo
  // target. Climbing out would index every sibling into one shared graph
  // DB at parent/.posse/atlas/<umbrella>.lbug — leaking gov-notice symbols
  // into mike's research surface.
  //
  // Linked git worktrees are different: they are another checkout of the same
  // repo, so they reuse the canonical ATLAS graph rooted at the main repo. ATLAS
  // still returns repo-relative file paths; deterministic tools resolve those
  // paths against the agent's worktree cwd when current contents matter.
  const useGitMainRepo = cwdGitInfo?.isLinkedWorktree || (cwdMainRepoPath
    && normalizedCwd
    && pathsEqual(cwdMainRepoPath, normalizedCwd));
  const detectedRepoPath = useGitMainRepo ? cwdMainRepoPath : null;
  const gitMainSuppressed = !!cwdMainRepoPath && !useGitMainRepo;

  const repoPath = requestedRepoTarget || detectedRepoPath || normalizedCwd;
  const repoId = config.requestedRepoId || deriveRepoId(repoPath);
  const source = requestedRepoPath
    ? (requestedRepoTarget && !pathsEqual(requestedRepoTarget, requestedRepoPath) ? "configured-linked-worktree" : "configured")
    : detectedRepoPath
      ? (cwdGitInfo?.isLinkedWorktree ? "cwd-linked-worktree" : "cwd-main-repo")
      : gitMainSuppressed
        ? "cwd-nested-fallback"
        : cwd
          ? "cwd"
          : "none";

  return {
    repoPath,
    repoId,
    source,
    ready: !!repoPath,
  };
}

export async function resolveAtlasRepoTargetAsync({
  cwd = null,
  config = getAtlasIntegrationConfig(),
  signal = null,
} = {}) {
  const normalizedCwd = normalizeAbsolutePath(cwd);
  const requestedRepoPath = normalizeAbsolutePath(config.requestedRepoPath);
  const requestedGitInfo = requestedRepoPath ? await resolveGitRepoInfoFromCwdAsync(requestedRepoPath, { signal }) : null;
  const requestedRepoTarget = requestedGitInfo?.isLinkedWorktree && requestedGitInfo?.mainRepoPath
    ? requestedGitInfo.mainRepoPath
    : requestedRepoPath;
  const cwdGitInfo = cwd ? await resolveGitRepoInfoFromCwdAsync(cwd, { signal }) : null;
  const cwdMainRepoPath = cwdGitInfo?.mainRepoPath || null;
  const useGitMainRepo = cwdGitInfo?.isLinkedWorktree || (cwdMainRepoPath
    && normalizedCwd
    && pathsEqual(cwdMainRepoPath, normalizedCwd));
  const detectedRepoPath = useGitMainRepo ? cwdMainRepoPath : null;
  const gitMainSuppressed = !!cwdMainRepoPath && !useGitMainRepo;

  const repoPath = requestedRepoTarget || detectedRepoPath || normalizedCwd;
  const repoId = config.requestedRepoId || deriveRepoId(repoPath);
  const source = requestedRepoPath
    ? (requestedRepoTarget && !pathsEqual(requestedRepoTarget, requestedRepoPath) ? "configured-linked-worktree" : "configured")
    : detectedRepoPath
      ? (cwdGitInfo?.isLinkedWorktree ? "cwd-linked-worktree" : "cwd-main-repo")
      : gitMainSuppressed
        ? "cwd-nested-fallback"
        : cwd
          ? "cwd"
          : "none";

  return {
    repoPath,
    repoId,
    source,
    ready: !!repoPath,
  };
}
