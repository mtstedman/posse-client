import { CommitScope } from "../../../domains/git/classes/CommitScope.js";
import { parseJsonObject } from "../../../domains/queue/functions/payload.js";
import { normPath, normalizeRoots, isUnderRoot, rootsOverlap } from "../functions/path.js";

function normalizeFile(values = []) {
  const list = Array.isArray(values) ? values : [];
  const normalized = list
    .map((value) => normPath(value))
    .filter(Boolean)
    .map((value) => (process.platform === "win32" ? value.toLowerCase() : value));
  return [...new Set(normalized)];
}

function normalizeRoot(values = [], cwd = process.cwd()) {
  const normalized = normalizeRoots(values, cwd)
    .map((value) => normPath(value))
    .filter(Boolean)
    .map((value) => (process.platform === "win32" ? value.toLowerCase() : value));
  return [...new Set(normalized)];
}

function hasMappings(mappings) {
  return Array.isArray(mappings) && mappings.length > 0;
}

function looksLikeFileDestination(value) {
  const base = String(value || "").replace(/\\/g, "/").split("/").at(-1) || "";
  const separator = base.lastIndexOf(".");
  if (separator < 0 || separator === base.length - 1) return false;
  return /^[A-Za-z0-9]+$/.test(base.slice(separator + 1));
}

function promotedScopeFromMappings(mappings, { cwd = process.cwd() } = {}) {
  if (!hasMappings(mappings)) return new CommitScope();
  const files = [];
  const roots = [];
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== "object") continue;
    const dest = String(mapping.dest || "").trim();
    if (!dest) continue;
    const wildcard = typeof mapping.pattern === "string" && mapping.pattern.startsWith("*.");
    const fileDestination = mapping.destination_type === "file"
      || (!wildcard && looksLikeFileDestination(dest));
    (fileDestination ? files : roots).push(dest);
  }
  // Scheduler/handoff scope classification is local policy and runs during
  // boot lock-index reconstruction. It must not start a key-gated Git daemon;
  // actual commit-scope enforcement remains native-owned in CommitScope.
  return new CommitScope({ files, roots, cwd });
}

async function promotedScopeFromMappingsAsync(mappings, { cwd = process.cwd() } = {}) {
  return promotedScopeFromMappings(mappings, { cwd });
}

export class Scope {
  constructor({
    modifyFiles = [],
    createFiles = [],
    createRoots = [],
    deleteFiles = [],
    cwd = process.cwd(),
  } = {}) {
    this.modifyFiles = Object.freeze(normalizeFile(modifyFiles));
    this.createFiles = Object.freeze(normalizeFile(createFiles));
    this.createRoots = Object.freeze(normalizeRoot(createRoots, cwd));
    this.deleteFiles = Object.freeze(normalizeFile(deleteFiles));
    Object.freeze(this);
  }

  static fromPayload(payload = {}, { cwd = process.cwd() } = {}) {
    const parsed = parseJsonObject(payload);
    const promoted = promotedScopeFromMappings(parsed.mappings, { cwd });
    return new Scope({
      modifyFiles: parsed.files_to_modify || [],
      createFiles: [...(parsed.files_to_create || []), ...promoted.files],
      createRoots: [...(parsed.create_roots || []), ...promoted.roots],
      deleteFiles: parsed.files_to_delete || [],
      cwd,
    });
  }

  static async fromPayloadAsync(payload = {}, { cwd = process.cwd() } = {}) {
    const parsed = parseJsonObject(payload);
    const promoted = await promotedScopeFromMappingsAsync(parsed.mappings, { cwd });
    return new Scope({
      modifyFiles: parsed.files_to_modify || [],
      createFiles: [...(parsed.files_to_create || []), ...promoted.files],
      createRoots: [...(parsed.create_roots || []), ...promoted.roots],
      deleteFiles: parsed.files_to_delete || [],
      cwd,
    });
  }

  static fromMappings(mappings = [], { cwd = process.cwd() } = {}) {
    const commitScope = promotedScopeFromMappings(mappings, { cwd });
    return new Scope({
      modifyFiles: [],
      createFiles: [...commitScope.files],
      createRoots: [...commitScope.roots],
      deleteFiles: [],
      cwd,
    });
  }

  static async fromMappingsAsync(mappings = [], { cwd = process.cwd() } = {}) {
    const commitScope = await promotedScopeFromMappingsAsync(mappings, { cwd });
    return new Scope({
      modifyFiles: [],
      createFiles: [...commitScope.files],
      createRoots: [...commitScope.roots],
      deleteFiles: [],
      cwd,
    });
  }

  static fromCommitScope(commitScope = null, { cwd = process.cwd() } = {}) {
    const scope = commitScope instanceof CommitScope
      ? commitScope
      : new CommitScope(commitScope || {});
    return new Scope({
      modifyFiles: [...scope.files],
      createFiles: [],
      createRoots: [...scope.roots],
      deleteFiles: [],
      cwd,
    });
  }

  isEmpty() {
    return this.modifyFiles.length === 0
      && this.createFiles.length === 0
      && this.createRoots.length === 0
      && this.deleteFiles.length === 0;
  }

  isUnscoped() {
    return this.isEmpty();
  }

  allFiles() {
    return Object.freeze([
      ...this.modifyFiles,
      ...this.createFiles,
      ...this.deleteFiles,
    ]);
  }

  contains(filePath) {
    let normalized = normPath(filePath);
    if (process.platform === "win32") normalized = normalized.toLowerCase();
    if (!normalized) return false;
    const inFiles = this.allFiles().includes(normalized);
    if (inFiles) return true;
    return isUnderRoot(normalized, this.createRoots);
  }

  toLockRows() {
    const files = this.allFiles().map((path) => ({ lockKind: "file", path }));
    const roots = this.createRoots.map((path) => ({ lockKind: "root", path }));
    return Object.freeze([...files, ...roots]);
  }

  conflictsWith(other) {
    const rhs = other instanceof Scope ? other : new Scope(other || {});
    const leftRows = this.toLockRows();
    const rightRows = rhs.toLockRows();
    for (const left of leftRows) {
      for (const right of rightRows) {
        if (left.lockKind === "file" && right.lockKind === "file" && left.path === right.path) return true;
        if (left.lockKind === "file" && right.lockKind === "root" && isUnderRoot(left.path, [right.path])) return true;
        if (left.lockKind === "root" && right.lockKind === "file" && isUnderRoot(right.path, [left.path])) return true;
        if (left.lockKind === "root" && right.lockKind === "root") {
          if (rootsOverlap(left.path, right.path)) return true;
        }
      }
    }
    return false;
  }

  union(other) {
    const rhs = other instanceof Scope ? other : new Scope(other || {});
    // No cwd forwarding needed: createRoots on `this` and `rhs` are already
    // normalized to relative paths (or "*") by their respective constructors.
    // Re-normalization in the new Scope's constructor is idempotent for
    // already-relative inputs — absolute-path resolution only fires for
    // path.isAbsolute() inputs, which the source roots are not.
    return new Scope({
      modifyFiles: [...this.modifyFiles, ...rhs.modifyFiles],
      createFiles: [...this.createFiles, ...rhs.createFiles],
      createRoots: [...this.createRoots, ...rhs.createRoots],
      deleteFiles: [...this.deleteFiles, ...rhs.deleteFiles],
    });
  }

  toJSON() {
    return {
      modifyFiles: [...this.modifyFiles],
      createFiles: [...this.createFiles],
      createRoots: [...this.createRoots],
      deleteFiles: [...this.deleteFiles],
    };
  }
}
