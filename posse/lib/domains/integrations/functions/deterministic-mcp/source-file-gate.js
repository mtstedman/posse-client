import fs from "node:fs";
import path from "node:path";
import { ATLAS_INDEXABLE_SOURCE_EXTENSIONS } from "../../../../catalog/files.js";
import { hasWindowsPathRoot, toRepoRelativePath } from "../../../../shared/format/functions/display-paths.js";

export { ATLAS_INDEXABLE_SOURCE_EXTENSIONS };

const NATIVE_EXACT_READ_TOOLS = new Set(["read_file", "chain_read"]);
export const ATLAS_CHAIN_READ_MAX_LINES = 250;
const DIRECT_FILE_KEYS = ["file", "filePath", "path"];
const ARRAY_FILE_KEYS = [
  "files",
  "filePaths",
  "paths",
  "focusPaths",
  "editedFiles",
  "seedFiles",
  "targetFiles",
  "changedFiles",
];

export function normalizeRepoPathForGate(value, { cwd = null } = {}) {
  let raw = String(value ?? "").trim();
  if (!raw || raw.includes("\0")) return null;
  raw = raw.replace(/^file:\/\/\/?/iu, "");

  const absolute = path.isAbsolute(raw) || hasWindowsPathRoot(raw);
  if (absolute) raw = toRepoRelativePath(cwd, raw);
  if (!raw) return null;

  let text = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/+$/g, "");
  if (!text || text.includes(":")) return null;
  if (text.startsWith("/") || text.startsWith("../") || text === "..") return null;

  const parts = text.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return text;
}

export function isIndexableSourcePath(value, { cwd = null } = {}) {
  const normalized = normalizeRepoPathForGate(value, { cwd });
  if (!normalized) return false;
  const ext = path.posix.extname(normalized.toLowerCase());
  return ATLAS_INDEXABLE_SOURCE_EXTENSIONS.has(ext);
}

export function isEmptySourceFileForGate(value, { cwd = null } = {}) {
  const normalized = normalizeRepoPathForGate(value, { cwd });
  if (!normalized || !cwd) return false;
  try {
    const target = path.resolve(String(cwd), ...normalized.split("/"));
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === 0;
  } catch {
    return false;
  }
}

// A cheap worktree-version marker for source evidence returned by ATLAS. The
// marker is intentionally metadata-only: reading and hashing every surveyed
// source file would recreate the raw-I/O cost this gate is meant to avoid.
// BigInt stats retain nanosecond mtimes where the platform exposes them, so a
// same-size edit still invalidates the evidence on normal local filesystems.
export function sourceFileVersionForGate(value, { cwd = null } = {}) {
  const normalized = normalizeRepoPathForGate(value, { cwd });
  if (!normalized || !cwd) return null;
  try {
    const target = path.resolve(String(cwd), ...normalized.split("/"));
    const stat = fs.statSync(target, { bigint: true });
    if (!stat.isFile()) return null;
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String).join(":");
  } catch {
    return null;
  }
}

function addPath(out, value, { cwd = null, onlyIndexable = true } = {}) {
  const normalized = normalizeRepoPathForGate(value, { cwd });
  if (!normalized) return;
  if (onlyIndexable && !isIndexableSourcePath(normalized)) return;
  out.set(normalized.toLowerCase(), normalized);
}

function addArray(out, value, opts = {}) {
  if (!Array.isArray(value)) return;
  for (const item of value) addPath(out, item, opts);
}

function addSymbolRefs(out, value, opts = {}) {
  const refs = Array.isArray(value) ? value : (value ? [value] : []);
  for (const ref of refs) {
    if (ref && typeof ref === "object") {
      addPath(out, ref.file || ref.filePath || ref.path, opts);
    }
  }
}

export function nativeIndexedReadTargets(toolName, args = {}, { cwd = null } = {}) {
  const normalizedTool = String(toolName || "");
  if (!NATIVE_EXACT_READ_TOOLS.has(normalizedTool)) return [];
  const out = new Map();
  addPath(out, args?.path || args?.file || args?.filePath, { cwd, onlyIndexable: true });
  return [...out.values()];
}

export function applyNativeReadLineLimit(args = {}, decision = {}) {
  const effectiveLineLimit = Number(decision?.effectiveLineLimit);
  if (!Number.isInteger(effectiveLineLimit) || effectiveLineLimit <= 0) return args;
  return { ...args, limit: effectiveLineLimit };
}

export function atlasDiscoveryFileTargets(action, args = {}, artifacts = null, { cwd = null } = {}) {
  const out = new Map();
  const input = args && typeof args === "object" ? args : {};
  for (const key of DIRECT_FILE_KEYS) addPath(out, input[key], { cwd, onlyIndexable: true });
  for (const key of ARRAY_FILE_KEYS) addArray(out, input[key], { cwd, onlyIndexable: true });
  addSymbolRefs(out, input.symbolRef, { cwd, onlyIndexable: true });
  addSymbolRefs(out, input.symbolRefs, { cwd, onlyIndexable: true });

  const options = input.options && typeof input.options === "object" ? input.options : null;
  if (options) {
    for (const key of ARRAY_FILE_KEYS) addArray(out, options[key], { cwd, onlyIndexable: true });
  }

  const artifactSymbols = Array.isArray(artifacts?.symbols) ? artifacts.symbols : [];
  for (const symbol of artifactSymbols) {
    addPath(out, symbol?.filePath || symbol?.file || symbol?.path, { cwd, onlyIndexable: true });
  }

  return [...out.values()];
}
