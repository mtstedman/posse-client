import path from "node:path";
import { ATLAS_INDEXABLE_SOURCE_EXTENSIONS } from "../../../../catalog/files.js";

export { ATLAS_INDEXABLE_SOURCE_EXTENSIONS };

const NATIVE_EXACT_READ_TOOLS = new Set(["read_file", "chain_read"]);
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

function hasWindowsDrive(value) {
  return /^[A-Za-z]:[\\/]/u.test(String(value || ""));
}

function normalizeAbsolutePath(value, cwd = null) {
  if (!cwd) return null;
  const raw = String(value || "").trim();
  const rootRaw = String(cwd || "").trim();
  if (!raw || !rootRaw) return null;

  const winMode = hasWindowsDrive(raw) || hasWindowsDrive(rootRaw);
  const api = winMode ? path.win32 : path;
  const root = api.resolve(rootRaw);
  const absolute = api.resolve(raw);
  const rel = api.relative(root, absolute).replace(/\\/g, "/");
  if (!rel || rel === ".") return null;
  if (rel.startsWith("../") || rel === ".." || api.isAbsolute(rel)) return null;
  return rel;
}

export function normalizeRepoPathForGate(value, { cwd = null } = {}) {
  let raw = String(value ?? "").trim();
  if (!raw || raw.includes("\0")) return null;
  raw = raw.replace(/^file:\/\/\/?/iu, "");

  const absolute = path.isAbsolute(raw) || hasWindowsDrive(raw);
  if (absolute) raw = normalizeAbsolutePath(raw, cwd);
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
