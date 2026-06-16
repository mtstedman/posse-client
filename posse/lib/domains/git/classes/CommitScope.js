// lib/domains/git/classes/CommitScope.js
//
// Immutable write-scope value object. It intentionally mirrors the scheduler's
// current lock semantics so callers can migrate without changing contention.

import { normPath, normalizeRoots, isUnderRoot, rootsOverlap } from "../../worker/functions/helpers/scope.js";
import { parseJsonObject } from "../../queue/functions/payload.js";
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

function normalizePromoteMappings(mappings = []) {
  const files = [];
  const roots = [];
  if (!Array.isArray(mappings)) return { files, roots };

  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object") continue;
    const dest = String(mapping.dest || "").trim();
    if (!dest) continue;
    const wildcard = typeof mapping.pattern === "string" && mapping.pattern.startsWith("*.");
    const fileDest = mapping.destination_type === "file"
      || (!wildcard && /\.[A-Za-z0-9]+$/.test(dest));
    if (fileDest) files.push(dest);
    else roots.push(dest);
  }

  return { files, roots };
}

function rowsConflict(left, right) {
  if (left.lock_kind === "file" && right.lock_kind === "file") return left.path === right.path;
  if (left.lock_kind === "file" && right.lock_kind === "root") return isUnderRoot(left.path, [right.path]);
  if (left.lock_kind === "root" && right.lock_kind === "file") return isUnderRoot(right.path, [left.path]);
  if (left.lock_kind === "root" && right.lock_kind === "root") {
    return rootsOverlap(left.path, right.path);
  }
  return false;
}

function nativeOptions(options = {}) {
  const { nativeParity, ...rest } = options || {};
  return rest;
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
    const value = runGitNativeMethod("git.commitScope.fromInput", nativeOptions(options), options.nativeParity || {});
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static async emptyAsync(options = {}) {
    const value = await runGitNativeMethodAsync("git.commitScope.fromInput", nativeOptions(options), options.nativeParity || {});
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static wildcard(options = {}) {
    const input = { ...nativeOptions(options), roots: ["*"], unknown: options.unknown ?? true };
    const value = runGitNativeMethod("git.commitScope.fromInput", input, options.nativeParity || {});
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static async wildcardAsync(options = {}) {
    const input = { ...nativeOptions(options), roots: ["*"], unknown: options.unknown ?? true };
    const value = await runGitNativeMethodAsync("git.commitScope.fromInput", input, options.nativeParity || {});
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static fromPayload(payload = {}, options = {}) {
    const value = runGitNativeMethod(
      "git.commitScope.fromPayload",
      { payload, options: nativeOptions(options) },
      options.nativeParity || {},
    );
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static async fromPayloadAsync(payload = {}, options = {}) {
    const value = await runGitNativeMethodAsync(
      "git.commitScope.fromPayload",
      { payload, options: nativeOptions(options) },
      options.nativeParity || {},
    );
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static fromJob(job = {}, options = {}) {
    return CommitScope.fromPayload(job.payload_json, options);
  }

  static fromJobAsync(job = {}, options = {}) {
    return CommitScope.fromPayloadAsync(job.payload_json, options);
  }

  hasScope(nativeParity = {}) {
    return runGitNativeMethod("git.commitScope.hasScope", this, nativeParity);
  }

  isWildcard(nativeParity = {}) {
    return runGitNativeMethod("git.commitScope.isWildcard", this, nativeParity);
  }

  containsFile(filePath, nativeParity = {}) {
    return runGitNativeMethod("git.commitScope.containsFile", { scope: this, filePath }, nativeParity);
  }

  toLockRows(nativeParity = {}) {
    return runGitNativeMethod("git.commitScope.lockRows", this, nativeParity);
  }

  findConflict(other, nativeParity = {}) {
    const right = other instanceof CommitScope ? other : new CommitScope(other);
    return runGitNativeMethod("git.commitScope.findConflict", { left: this, right }, nativeParity);
  }

  conflictsWith(other, nativeParity = {}) {
    const right = other instanceof CommitScope ? other : new CommitScope(other);
    return runGitNativeMethod("git.commitScope.conflictsWith", { left: this, right }, nativeParity);
  }

  toJSON() {
    return {
      files: [...this.files],
      roots: [...this.roots],
      unknown: this.unknown,
    };
  }
}
