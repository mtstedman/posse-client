// lib/domains/git/classes/Worktree.js
//
// Low-level worktree lifecycle wrapper. Higher-level worker recovery logic can
// keep its current shape while command execution moves behind Repo.

import fs from "node:fs";
import path from "node:path";
import { Repo } from "./Repo.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "../functions/native/invoke.js";

function ensureRepo(repoOrCwd) {
  return repoOrCwd instanceof Repo ? repoOrCwd : new Repo(repoOrCwd);
}

function isBranchAlreadyExistsError(error) {
  const text = String(error?.stderr || error?.message || error || "");
  return /branch\b.*\balready exists\b|\balready exists\b.*\bbranch\b/i.test(text);
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

  exists(nativeParity = {}) {
    return runGitNativeMethod("git.worktree.exists", { wtPath: this.path }, nativeParity);
  }

  async existsAsync(nativeParity = {}) {
    return await runGitNativeMethodAsync(
      "git.worktree.exists",
      { wtPath: this.path },
      nativeParity,
    );
  }

  currentBranch(nativeParity = {}) {
    return runGitNativeMethod("git.worktree.currentBranch", { wtPath: this.path }, nativeParity);
  }

  async currentBranchAsync({ signal = undefined, nativeParity = {} } = {}) {
    return await runGitNativeMethodAsync(
      "git.worktree.currentBranch",
      { wtPath: this.path },
      { ...nativeParity, signal },
    );
  }

  isUsable(nativeParity = {}) {
    return runGitNativeMethod("git.worktree.isUsable", { wtPath: this.path }, nativeParity);
  }

  async isUsableAsync({ signal = undefined, nativeParity = {} } = {}) {
    return await runGitNativeMethodAsync(
      "git.worktree.isUsable",
      { wtPath: this.path },
      { ...nativeParity, signal },
    );
  }

  add({ branchName = this.branchName, createBranch = null } = {}) {
    if (!branchName) throw new Error("Worktree.add requires branchName");
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const autoCreateBranch = createBranch == null;
    // Don't pre-check branch existence (it's a native call now); just try to
    // create the branch and, in auto mode, attach to it if it already exists.
    if (autoCreateBranch || createBranch) {
      try {
        this.repo.worktree(["add", "-b", branchName, this.path]);
      } catch (error) {
        if (!autoCreateBranch || !isBranchAlreadyExistsError(error)) throw error;
        this.repo.worktree(["add", this.path, branchName]);
      }
    } else {
      this.repo.worktree(["add", this.path, branchName]);
    }
    return this.path;
  }

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

  remove({ force = true, prune = true, fallbackRemove = true } = {}) {
    try {
      this.repo.worktree(["remove", this.path, ...(force ? ["--force"] : [])]);
    } catch (error) {
      if (!fallbackRemove) throw error;
    }
    if (prune) {
      try { this.prune(); } catch { /* best effort */ }
    }
    if (fallbackRemove && fs.existsSync(this.path)) {
      try { fs.rmSync(this.path, { recursive: true, force: true }); } catch { /* caller retry/add will surface persistent failures */ }
    }
    if (prune) {
      try { this.prune(); } catch { /* best effort */ }
    }
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

  move(targetPath, { fallbackRename = false, repair = true } = {}) {
    const resolvedTarget = path.resolve(targetPath);
    try {
      this.repo.worktree(["move", this.path, resolvedTarget]);
      return resolvedTarget;
    } catch (error) {
      if (!fallbackRename) throw error;
    }

    fs.renameSync(this.path, resolvedTarget);
    if (repair) {
      // Repair must run before prune: prune treats the renamed worktree's
      // admin metadata as orphaned and deletes it immediately, after which
      // repair has nothing left to fix and the migrated worktree is corrupt.
      try { this.repo.worktree(["repair", resolvedTarget]); } catch { /* verified below */ }
      try { this.repo.worktree(["prune"]); } catch { /* best effort */ }
      try {
        this.repo.exec(["rev-parse", "--git-dir"], { cwd: resolvedTarget });
      } catch (verifyError) {
        const err = new Error(`Worktree move fallback left ${resolvedTarget} without usable git metadata: ${verifyError?.message || verifyError}`);
        err.code = "WORKTREE_MOVE_REPAIR_FAILED";
        throw err;
      }
    }
    return resolvedTarget;
  }

  repair() {
    return this.repo.worktree(["repair", this.path]);
  }

  prune() {
    return this.repo.worktree(["prune"]);
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
