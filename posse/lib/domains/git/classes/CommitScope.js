// lib/domains/git/classes/CommitScope.js
//
// Immutable write-scope value object. Scope parsing and lock semantics are
// Rust-owned; this class only normalizes returned values and dispatches native
// methods.

import { normPath, normalizeRoots } from "../../../shared/scope/functions/path.js";
import { runGitNativeMethod, runGitNativeMethodAsync } from "../functions/native/invoke.js";

function normalizeLockPath(value) {
  const normalized = normPath(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeFileList(values = []) {
  const list = Array.isArray(values) ? values : [];
  return unique(list.map(normalizeLockPath));
}

function normalizeRootList(values = [], cwd = process.cwd()) {
  return unique(
    normalizeRoots(Array.isArray(values) ? values : [], cwd)
      .map(normalizeLockPath)
      .map((root) => root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root)
  );
}

function nativeOptions(options = {}) {
  const { nativeParity, ...rest } = options || {};
  return rest;
}

function commitScopeFromNative(value, method) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Git native method ${method} returned invalid CommitScope`);
  }
  return new CommitScope(value);
}

function lockRowsFromNative(value, method) {
  if (!Array.isArray(value)) {
    throw new Error(`Git native method ${method} returned invalid lock rows`);
  }
  return Object.freeze(value.map((row) => Object.freeze({ ...row })));
}

export class CommitScope {
  constructor({
    files = [],
    roots = [],
    unknown = false,
    cwd = process.cwd(),
  } = {}) {
    this.files = Object.freeze(normalizeFileList(files));
    this.roots = Object.freeze(normalizeRootList(roots, cwd));
    this.unknown = Boolean(unknown);
    Object.freeze(this);
  }

  static empty(options = {}) {
    const input = nativeOptions(options);
    const value = runGitNativeMethod("git.commitScope.fromInput", input, options.nativeParity || {});
    return commitScopeFromNative(value, "git.commitScope.fromInput");
  }

  static async emptyAsync(options = {}) {
    const input = nativeOptions(options);
    const value = await runGitNativeMethodAsync("git.commitScope.fromInput", input, options.nativeParity || {});
    return commitScopeFromNative(value, "git.commitScope.fromInput");
  }

  static wildcard(options = {}) {
    const input = { ...nativeOptions(options), roots: ["*"], unknown: options.unknown ?? true };
    const value = runGitNativeMethod("git.commitScope.fromInput", input, options.nativeParity || {});
    return commitScopeFromNative(value, "git.commitScope.fromInput");
  }

  static async wildcardAsync(options = {}) {
    const input = { ...nativeOptions(options), roots: ["*"], unknown: options.unknown ?? true };
    const value = await runGitNativeMethodAsync("git.commitScope.fromInput", input, options.nativeParity || {});
    return commitScopeFromNative(value, "git.commitScope.fromInput");
  }

  static fromPayload(payload = {}, options = {}) {
    const opts = nativeOptions(options);
    const value = runGitNativeMethod(
      "git.commitScope.fromPayload",
      { payload, options: opts },
      options.nativeParity || {},
    );
    return commitScopeFromNative(value, "git.commitScope.fromPayload");
  }

  static async fromPayloadAsync(payload = {}, options = {}) {
    const opts = nativeOptions(options);
    const value = await runGitNativeMethodAsync(
      "git.commitScope.fromPayload",
      { payload, options: opts },
      options.nativeParity || {},
    );
    return commitScopeFromNative(value, "git.commitScope.fromPayload");
  }

  static fromJob(job = {}, options = {}) {
    return CommitScope.fromPayload(job.payload_json, options);
  }

  static fromJobAsync(job = {}, options = {}) {
    return CommitScope.fromPayloadAsync(job.payload_json, options);
  }

  hasScope(nativeParity = {}) {
    return Boolean(runGitNativeMethod("git.commitScope.hasScope", this, nativeParity));
  }

  isWildcard(nativeParity = {}) {
    return Boolean(runGitNativeMethod("git.commitScope.isWildcard", this, nativeParity));
  }

  containsFile(filePath, nativeParity = {}) {
    return Boolean(runGitNativeMethod("git.commitScope.containsFile", { scope: this, filePath }, nativeParity));
  }

  toLockRows(nativeParity = {}) {
    const rows = runGitNativeMethod("git.commitScope.lockRows", this, nativeParity);
    return lockRowsFromNative(rows, "git.commitScope.lockRows");
  }

  findConflict(other, nativeParity = {}) {
    const right = other instanceof CommitScope ? other : new CommitScope(other);
    return runGitNativeMethod("git.commitScope.findConflict", { left: this, right }, nativeParity);
  }

  conflictsWith(other, nativeParity = {}) {
    const right = other instanceof CommitScope ? other : new CommitScope(other);
    return Boolean(runGitNativeMethod("git.commitScope.conflictsWith", { left: this, right }, nativeParity));
  }

  toJSON() {
    return {
      files: [...this.files],
      roots: [...this.roots],
      unknown: this.unknown,
    };
  }
}
