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

function isAbortLike(err) {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR" || err?.code === "THREAD_ABORTED";
}

function shouldFallbackNativeScope(err) {
  return !isAbortLike(err);
}

function nodeScopeFromInput(input = {}, options = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    files: normalizeFileList(source.files || []),
    roots: normalizeRootList(source.roots || [], source.cwd || options.cwd || process.cwd()),
    unknown: Boolean(source.unknown),
  };
}

function nodeScopeFromPayload(payload = {}, options = {}) {
  const parsed = parseJsonObject(payload);
  const promoted = normalizePromoteMappings(parsed.mappings || []);
  return nodeScopeFromInput({
    files: [
      ...(Array.isArray(parsed.files_to_modify) ? parsed.files_to_modify : []),
      ...(Array.isArray(parsed.files_to_create) ? parsed.files_to_create : []),
      ...(Array.isArray(parsed.files_to_delete) ? parsed.files_to_delete : []),
      ...promoted.files,
    ],
    roots: [
      ...(Array.isArray(parsed.create_roots) ? parsed.create_roots : []),
      ...promoted.roots,
    ],
    unknown: parsed.unknown === true,
    cwd: options.cwd,
  }, options);
}

function nodeHasScope(scope) {
  return Boolean(scope?.unknown) || (scope?.files || []).length > 0 || (scope?.roots || []).length > 0;
}

function nodeIsWildcard(scope) {
  return Boolean(scope?.unknown) || (scope?.roots || []).includes("*");
}

function nodeContainsFile(scope, filePath) {
  if (nodeIsWildcard(scope)) return true;
  const normalized = normalizeLockPath(filePath);
  if (!normalized) return false;
  if ((scope?.files || []).includes(normalized)) return true;
  return isUnderRoot(normalized, scope?.roots || []);
}

function nodeLockRows(scope) {
  return Object.freeze([
    ...(scope?.files || []).map((path) => ({ path, lock_kind: "file" })),
    ...(scope?.roots || []).map((path) => ({ path, lock_kind: "root" })),
  ]);
}

function nodeFindConflict(left, right) {
  for (const leftRow of nodeLockRows(left)) {
    for (const rightRow of nodeLockRows(right)) {
      if (rowsConflict(leftRow, rightRow)) return { left: leftRow, right: rightRow };
    }
  }
  return null;
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
    let value;
    try {
      value = runGitNativeMethod("git.commitScope.fromInput", input, options.nativeParity || {});
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      value = nodeScopeFromInput(input, options);
    }
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static async emptyAsync(options = {}) {
    const input = nativeOptions(options);
    let value;
    try {
      value = await runGitNativeMethodAsync("git.commitScope.fromInput", input, options.nativeParity || {});
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      value = nodeScopeFromInput(input, options);
    }
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static wildcard(options = {}) {
    const input = { ...nativeOptions(options), roots: ["*"], unknown: options.unknown ?? true };
    let value;
    try {
      value = runGitNativeMethod("git.commitScope.fromInput", input, options.nativeParity || {});
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      value = nodeScopeFromInput(input, options);
    }
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static async wildcardAsync(options = {}) {
    const input = { ...nativeOptions(options), roots: ["*"], unknown: options.unknown ?? true };
    let value;
    try {
      value = await runGitNativeMethodAsync("git.commitScope.fromInput", input, options.nativeParity || {});
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      value = nodeScopeFromInput(input, options);
    }
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static fromPayload(payload = {}, options = {}) {
    const opts = nativeOptions(options);
    let value;
    try {
      value = runGitNativeMethod(
        "git.commitScope.fromPayload",
        { payload, options: opts },
        options.nativeParity || {},
      );
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      value = nodeScopeFromPayload(payload, opts);
    }
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static async fromPayloadAsync(payload = {}, options = {}) {
    const opts = nativeOptions(options);
    let value;
    try {
      value = await runGitNativeMethodAsync(
        "git.commitScope.fromPayload",
        { payload, options: opts },
        options.nativeParity || {},
      );
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      value = nodeScopeFromPayload(payload, opts);
    }
    return new CommitScope(value && typeof value === "object" ? value : {});
  }

  static fromJob(job = {}, options = {}) {
    return CommitScope.fromPayload(job.payload_json, options);
  }

  static fromJobAsync(job = {}, options = {}) {
    return CommitScope.fromPayloadAsync(job.payload_json, options);
  }

  hasScope(nativeParity = {}) {
    try {
      return runGitNativeMethod("git.commitScope.hasScope", this, nativeParity);
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      return nodeHasScope(this);
    }
  }

  isWildcard(nativeParity = {}) {
    try {
      return runGitNativeMethod("git.commitScope.isWildcard", this, nativeParity);
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      return nodeIsWildcard(this);
    }
  }

  containsFile(filePath, nativeParity = {}) {
    try {
      return runGitNativeMethod("git.commitScope.containsFile", { scope: this, filePath }, nativeParity);
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      return nodeContainsFile(this, filePath);
    }
  }

  toLockRows(nativeParity = {}) {
    try {
      return runGitNativeMethod("git.commitScope.lockRows", this, nativeParity);
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      return nodeLockRows(this);
    }
  }

  findConflict(other, nativeParity = {}) {
    const right = other instanceof CommitScope ? other : new CommitScope(other);
    try {
      return runGitNativeMethod("git.commitScope.findConflict", { left: this, right }, nativeParity);
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      return nodeFindConflict(this, right);
    }
  }

  conflictsWith(other, nativeParity = {}) {
    const right = other instanceof CommitScope ? other : new CommitScope(other);
    try {
      return runGitNativeMethod("git.commitScope.conflictsWith", { left: this, right }, nativeParity);
    } catch (err) {
      if (!shouldFallbackNativeScope(err)) throw err;
      return nodeFindConflict(this, right) != null;
    }
  }

  toJSON() {
    return {
      files: [...this.files],
      roots: [...this.roots],
      unknown: this.unknown,
    };
  }
}
