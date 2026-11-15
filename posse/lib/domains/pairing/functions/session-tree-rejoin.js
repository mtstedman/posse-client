// @ts-check
// Rejoining a tree the host left up: bring its branch back up to date with the
// trunk and publish it to the kept private repository, so a new session can
// start on it instead of uploading the whole history again.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function defaultGit(args, cwd) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 }) || "").trim();
}

function succeeds(git, args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

function rejoinError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Whether a kept tree can still be rejoined: its branch is here, its key is on
 * disk. The repository itself is checked separately (it needs the network).
 *
 * @param {string} projectDir
 * @param {{ branch: string, credentialDirectory: string|null, repository: string|null }} tree
 */
export function keptTreeProblem(projectDir, tree, { git = defaultGit } = {}) {
  if (!tree.repository) return "its private repository was not kept";
  if (!succeeds(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${tree.branch}`], projectDir)) {
    return "its local branch is gone";
  }
  if (!tree.credentialDirectory || !fs.existsSync(path.join(tree.credentialDirectory, "id_ed25519"))) {
    return "its session key is gone";
  }
  return null;
}

/**
 * Put the kept branch on top of the trunk and publish it to the session
 * remote. Never rewrites history and never force-pushes: the trunk is merged
 * into the branch, and a diverged session repository or a merge conflict
 * refuses the rejoin and leaves everything as it was.
 *
 * @param {string} projectDir the host checkout, on the default branch with a clean tree
 * @param {{ branch: string, remote: string, defaultBranch: string, trunkRef: string }} target
 * @param {{ git?: (args: string[], cwd: string) => string, onProgress?: (message: string) => void }} [deps]
 * @returns {Promise<string>} the branch tip now published
 */
export async function rejoinKeptBranch(projectDir, { branch, remote, defaultBranch, trunkRef }, { git = defaultGit, onProgress = () => {} } = {}) {
  const localRef = `refs/heads/${branch}`;
  const remoteTracking = `refs/remotes/${remote}/${branch}`;
  if (!succeeds(git, ["rev-parse", "--verify", "--quiet", localRef], projectDir)) {
    throw rejoinError("pairing_rejoin_branch_missing", `The local branch ${branch} is gone`);
  }
  onProgress("checking the kept repository");
  const remoteHead = git(["ls-remote", "--heads", remote, `refs/heads/${branch}`], projectDir).split(/\s+/u)[0] || "";
  if (remoteHead) {
    git(["fetch", "--no-tags", remote, `+refs/heads/${branch}:${remoteTracking}`], projectDir);
    const localTip = git(["rev-parse", localRef], projectDir);
    if (remoteHead !== localTip) {
      if (succeeds(git, ["merge-base", "--is-ancestor", localTip, remoteTracking], projectDir)) {
        git(["branch", "-f", branch, remoteTracking], projectDir); // the repository is ahead: take it
      } else if (!succeeds(git, ["merge-base", "--is-ancestor", remoteTracking, localRef], projectDir)) {
        throw rejoinError("pairing_rejoin_diverged",
          `${branch} and its kept repository have diverged; purge the tree (posse session trees purge) and start a new one`);
      }
    }
  }
  git(["switch", branch], projectDir);
  try {
    if (!succeeds(git, ["merge-base", "--is-ancestor", trunkRef, "HEAD"], projectDir)) {
      onProgress(`bringing ${branch} up to date with ${trunkRef}`);
      try {
        git(["merge", "--no-edit", "-m", `Merge ${trunkRef} into session tree ${branch}`, trunkRef], projectDir);
      } catch (error) {
        succeeds(git, ["merge", "--abort"], projectDir);
        throw rejoinError("pairing_rejoin_conflict",
          `${branch} cannot be brought up to date with ${trunkRef} without conflicts; purge it and start a new tree (${String(error?.message || error).split("\n")[0]})`);
      }
    }
    const oid = git(["rev-parse", "HEAD"], projectDir);
    // The session repository needs the default branch before the session
    // branch: the Remote reads the repository's default.
    const hasDefault = git(["ls-remote", "--heads", remote, `refs/heads/${defaultBranch}`], projectDir).trim();
    if (!hasDefault) {
      onProgress(`publishing ${defaultBranch}`);
      git(["push", remote, `${oid}:refs/heads/${defaultBranch}`], projectDir);
    }
    onProgress(`publishing ${branch}`);
    git(["push", "--set-upstream", remote, `${oid}:refs/heads/${branch}`], projectDir);
    return oid;
  } catch (error) {
    // Leave the checkout where the host started so a refused rejoin changes nothing.
    succeeds(git, ["switch", defaultBranch], projectDir);
    throw error;
  }
}
