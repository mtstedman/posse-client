// lib/domains/git/classes/SnapshotRef.js
//
// Immutable reference to a preserved worktree/branch snapshot. It stringifies
// to the underlying ref/path so legacy logging and git-show call sites keep
// working while newer code can inspect storage metadata.

import { runGitNativeMethod } from "../functions/native/invoke.js";

export class SnapshotRef {
  constructor(value, {
    storageType = "git-ref",
    objectHash = null,
    projectDir = null,
    worktreePath = null,
    metadata = {},
  } = {}) {
    if (!value || typeof value !== "string") {
      throw new Error("SnapshotRef requires value");
    }
    this.value = value;
    this.storageType = storageType;
    this.objectHash = objectHash;
    this.projectDir = projectDir;
    this.worktreePath = worktreePath;
    this.metadata = Object.freeze({ ...(metadata || {}) });
    Object.freeze(this);
  }

  static gitRef(refName, options = {}) {
    return new SnapshotRef(refName, {
      ...options,
      storageType: options.storageType || "git-ref",
    });
  }

  static directory(snapshotPath, options = {}) {
    return new SnapshotRef(snapshotPath, {
      ...options,
      storageType: options.storageType || "directory-fallback",
    });
  }

  static from(value, options = {}) {
    return value instanceof SnapshotRef ? value : new SnapshotRef(String(value), options);
  }

  get refName() {
    return this.isGitRef() ? this.value : null;
  }

  get snapshotPath() {
    return this.isDirectory() ? this.value : null;
  }

  isGitRef() {
    return this.storageType === "git-ref" || this.storageType === "branch-ref";
  }

  isDirectory() {
    return this.storageType === "directory-fallback" || this.storageType === "corrupt-worktree-copy";
  }

  exists(repoOrCwd = this.projectDir || this.worktreePath, nativeParity = {}) {
    return runGitNativeMethod(
      "git.snapshot.exists",
      { snapshot: this.nativePayload(), repoCwd: typeof repoOrCwd === "string" ? repoOrCwd : repoOrCwd?.cwd || null },
      nativeParity,
    );
  }

  equals(other) {
    const ref = other instanceof SnapshotRef ? other : SnapshotRef.from(other);
    return this.value === ref.value && this.storageType === ref.storageType;
  }

  toString() {
    return this.value;
  }

  valueOf() {
    return this.value;
  }

  toJSON() {
    return this.value;
  }

  nativePayload() {
    return {
      value: this.value,
      storageType: this.storageType,
      objectHash: this.objectHash,
      projectDir: this.projectDir,
      worktreePath: this.worktreePath,
      metadata: this.metadata,
    };
  }

  [Symbol.toPrimitive]() {
    return this.value;
  }
}
