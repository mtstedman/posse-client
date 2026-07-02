// lib/domains/git/classes/Worktree.js
//
// Low-level worktree lifecycle wrapper. Higher-level worker recovery logic can
// keep its current shape while command execution moves behind Repo.

import path from "node:path";
import { Repo } from "./Repo.js";
import { runGitNativeMethodAsync } from "../functions/native/invoke.js";

function ensureRepo(repoOrCwd) {
  return repoOrCwd instanceof Repo ? repoOrCwd : new Repo(repoOrCwd);
}

export class Worktree {
  constructor(repoOrCwd, worktreePath, { branchName = null } = {}) {
    if (!worktreePath || typeof worktreePath !== "string") {
      throw new Error("Worktree requires path");
    }
    this.repo = ensureRepo(repoOrCwd);
    this.path = path.resolve(worktreePath);
    this.branchName = branchName;
    Object.freeze(this);
  }

  static at(repoOrCwd, worktreePath, options = {}) {
    return new Worktree(repoOrCwd, worktreePath, options);
  }

  async existsAsync(nativeParity = {}) {
    return await runGitNativeMethodAsync(
      "git.worktree.exists",
      { wtPath: this.path },
      nativeParity,
    );
  }

  async currentBranchAsync({ signal = undefined, nativeParity = {} } = {}) {
    return await runGitNativeMethodAsync(
      "git.worktree.currentBranch",
      { wtPath: this.path },
      { ...nativeParity, signal },
    );
  }

  async isUsableAsync({ signal = undefined, nativeParity = {} } = {}) {
    return await runGitNativeMethodAsync(
      "git.worktree.isUsable",
      { wtPath: this.path },
      { ...nativeParity, signal },
    );
  }

  // Worktree lifecycle semantics (branch-race fallback, prune, forced-removal
  // recovery) live entirely in the native Rust methods (git.worktree.add /
  // git.worktree.remove) — there is no Node implementation to keep in step.
  // The async class-contract tests pin the method → native routing.
  async addAsync({ branchName = this.branchName, createBranch = null, signal = undefined, nativeParity = {} } = {}) {
    if (!branchName) throw new Error("Worktree.add requires branchName");
    return await runGitNativeMethodAsync(
      "git.worktree.add",
      {
        mainCwd: this.repo.cwd,
        wtPath: this.path,
        branchName: String(branchName),
        createBranch,
      },
      { ...nativeParity, signal },
    );
  }

  async removeAsync({ force = true, prune = true, fallbackRemove = true, signal = undefined, nativeParity = {} } = {}) {
    await runGitNativeMethodAsync(
      "git.worktree.remove",
      {
        mainCwd: this.repo.cwd,
        wtPath: this.path,
        force: Boolean(force),
        prune: Boolean(prune),
        fallbackRemove: Boolean(fallbackRemove),
      },
      { ...nativeParity, signal },
    );
  }

  pruneAsync({ signal = undefined, nativeParity = {} } = {}) {
    return runGitNativeMethodAsync(
      "git.worktree.prune",
      { cwd: this.repo.cwd },
      { ...nativeParity, signal },
    ).then(() => "");
  }

  withPath(worktreePath, options = {}) {
    return new Worktree(this.repo, worktreePath, {
      branchName: options.branchName ?? this.branchName,
    });
  }
}
