// @ts-check
//
// Minimal live-buffer overlay for ATLAS v2. This keeps unsaved editor
// buffers visible to code/file retrieval without mutating the worktree
// unless a caller explicitly checkpoints with writeToDisk=true.

import fs from "fs";
import path from "path";
import { sha256Hex } from "../hash.js";
import { isCanonicalRepoPath } from "../paths.js";
import { atlasDir } from "../runtime-paths.js";
import { parseBuffer } from "../parser/adapter.js";
import { recordLiveBufferEvent, recordLiveCheckpoint } from "../live-reconciliation.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";

/** @typedef {import("../contracts/schemas.js").ParseResult} ParseResult */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {(path: string) => string | null} ReadFile */

/**
 * @typedef {Object} BufferPushParams
 * @property {string} filePath
 * @property {string} content
 * @property {string} [sessionId]
 * @property {number} [version]
 * @property {"open" | "change" | "save" | "close" | "checkpoint"} [eventType]
 * @property {string} [language]
 * @property {boolean} [dirty]
 * @property {string} [timestamp]
 * @property {{ line?: number, column?: number }} [cursor]
 * @property {Array<{ startLine?: number, startColumn?: number, endLine?: number, endColumn?: number }>} [selections]
 */

/**
 * @typedef {Object} BufferCheckpointParams
 * @property {string} filePath
 * @property {string} [sessionId]
 * @property {boolean} [writeToDisk]
 * @property {boolean} [clear]
 */

/**
 * @typedef {Object} BufferStatusParams
 * @property {string} [filePath]
 * @property {string} [sessionId]
 */

/**
 * @typedef {Object} BufferPushData
 * @property {string} filePath
 * @property {string} sessionId
 * @property {string} contentHash
 * @property {number} byteLength
 * @property {number | null} version
 * @property {boolean} parsed
 * @property {number} symbolCount
 * @property {boolean} [persisted]
 * @property {string} [eventType]
 * @property {string | null} [language]
 * @property {boolean} [dirty]
 * @property {Record<string, number> | null} [cursor]
 * @property {Array<Record<string, number>>} [selections]
 * @property {string} [updatedAt]
 * @property {string[]} [warnings]
 * @property {boolean} [replaced]
 */

/**
 * @typedef {Object} BufferCheckpointData
 * @property {string} filePath
 * @property {string} sessionId
 * @property {boolean} cleared
 * @property {boolean} wroteToDisk
 * @property {boolean} diskMatches
 * @property {string | null} contentHash
 */

/**
 * @typedef {Object} BufferStatusEntry
 * @property {string} filePath
 * @property {string} sessionId
 * @property {string} contentHash
 * @property {number} byteLength
 * @property {number | null} version
 * @property {boolean} diskMatches
 * @property {boolean} [persisted]
 * @property {string} updatedAt
 * @property {boolean} [parsed]
 * @property {number} [symbolCount]
 * @property {string} [eventType]
 * @property {string | null} [language]
 * @property {boolean} [dirty]
 * @property {Record<string, number> | null} [cursor]
 * @property {Array<Record<string, number>>} [selections]
 * @property {string[]} [warnings]
 */

/**
 * @typedef {Object} BufferStatusData
 * @property {BufferStatusEntry[]} buffers
 * @property {number} total
 * @property {number} [totalBytes]
 * @property {number} [dirtyCount]
 * @property {number} [parsedCount]
 * @property {number} [parseFailureCount]
 * @property {number} [syntaxErrorCount]
 * @property {number} [parseExceptionCount]
 * @property {number} [pendingParseCount]
 * @property {number} [draftLimit]
 * @property {boolean} [draftLimitReached]
 * @property {number} [staleRejectedCount]
 * @property {number} [versionConflictRejectedCount]
 * @property {number} [draftLimitRejectedCount]
 * @property {string | null} [lastUpdatedAt]
 * @property {string | null} [lastRejectedAt]
 * @property {string[]} [warnings]
 */

const DEFAULT_SESSION = "default";
const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
const LARGE_BUFFER_WARNING_BYTES = 4 * 1024 * 1024;
const MAX_DRAFT_FILES = 200;
const BUFFER_SCHEMA_VERSION = 1;
const ACTION_BUFFER_PUSH = /** @type {any} */ ("buffer.push");
const ACTION_BUFFER_STATUS = /** @type {any} */ ("buffer.status");
const ACTION_BUFFER_CHECKPOINT = /** @type {any} */ ("buffer.checkpoint");

/**
 * @typedef {Object} OverlayEntry
 * @property {string} repoRoot
 * @property {string} filePath
 * @property {string} sessionId
 * @property {string} content
 * @property {string} contentHash
 * @property {number} byteLength
 * @property {number | null} version
 * @property {string} updatedAt
 * @property {boolean} parsed
 * @property {number} symbolCount
 * @property {ParseResult | null} parseResult
 * @property {string} eventType
 * @property {string | null} language
 * @property {boolean} dirty
 * @property {Record<string, number> | null} cursor
 * @property {Array<Record<string, number>>} selections
 */

/**
 * @typedef {Object} RootStats
 * @property {number} staleRejectedCount
 * @property {number} versionConflictRejectedCount
 * @property {number} draftLimitRejectedCount
 * @property {string | null} lastRejectedAt
 */

/** @type {Map<string, OverlayEntry>} */
const BUFFERS = new Map();

/** @type {Set<string>} */
const LOADED_ROOTS = new Set();

/** @type {Map<string, RootStats>} */
const ROOT_STATS = new Map();

/**
 * @param {string | undefined} repoRoot
 * @param {string | undefined} filePath
 * @param {string | undefined} sessionId
 * @returns {string}
 */
function keyOf(repoRoot, filePath, sessionId) {
  return `${path.resolve(repoRoot || ".")}\0${sessionId || DEFAULT_SESSION}\0${filePath || ""}`;
}

/**
 * @param {string} root
 * @returns {string}
 */
function storeDir(root) {
  return path.join(atlasDir(root), "buffers");
}

/**
 * @param {string} root
 * @param {string} filePath
 * @param {string} sessionId
 * @returns {string}
 */
function storePath(root, filePath, sessionId) {
  const digest = sha256Hex(Buffer.from(`${sessionId}\0${filePath}`, "utf8"));
  return path.join(storeDir(root), `${digest}.json`);
}

/**
 * @param {unknown} sessionId
 * @returns {string}
 */
function normalizeSession(sessionId) {
  const s = String(sessionId || DEFAULT_SESSION).trim();
  return s || DEFAULT_SESSION;
}

/**
 * @param {string | undefined} repoRoot
 * @returns {string}
 */
function requireRepoRoot(repoRoot) {
  if (!repoRoot) throw new Error("buffer overlay requires repoRoot");
  return path.resolve(repoRoot);
}

/**
 * @param {string} root
 */
function rootStats(root) {
  const key = path.resolve(root);
  let stats = ROOT_STATS.get(key);
  if (!stats) {
    stats = { staleRejectedCount: 0, versionConflictRejectedCount: 0, draftLimitRejectedCount: 0, lastRejectedAt: null };
    ROOT_STATS.set(key, stats);
  }
  if (typeof stats.versionConflictRejectedCount !== "number") stats.versionConflictRejectedCount = 0;
  return stats;
}

/**
 * @param {{
 *   root: string,
 *   filePath: string,
 *   sessionId: string,
 *   content: string,
 *   version?: number | null,
 *   updatedAt?: string,
 *   metadata?: Record<string, unknown>,
 * }} args
 * @returns {OverlayEntry}
 */
function makeEntry({ root, filePath, sessionId, content, version = null, updatedAt, metadata = {} }) {
  let parsed = false;
  let symbolCount = 0;
  /** @type {ParseResult | null} */
  let parseResult = null;
  try {
    const result = parseBuffer({ bytes: content, repo_rel_path: filePath });
    parseResult = result;
    parsed = result.hasError !== true;
    symbolCount = result.symbols.length;
  } catch {
    parsed = false;
    symbolCount = 0;
  }
  const eventType = normalizeEventType(metadata.eventType);
  const language = normalizeLanguage(metadata.language) || parseResult?.lang || null;
  return {
    repoRoot: root,
    filePath,
    sessionId,
    content,
    contentHash: sha256Hex(Buffer.from(content, "utf8")),
    byteLength: Buffer.byteLength(content, "utf8"),
    version: Number.isFinite(Number(version)) ? Number(version) : null,
    updatedAt: updatedAt || normalizeTimestamp(metadata.timestamp) || new Date().toISOString(),
    parsed,
    symbolCount,
    parseResult,
    eventType,
    language,
    dirty: typeof metadata.dirty === "boolean" ? metadata.dirty : eventType !== "save",
    cursor: normalizeCursor(metadata.cursor),
    selections: normalizeSelections(metadata.selections),
  };
}

/**
 * @param {OverlayEntry} entry
 * @returns {boolean}
 */
function persistEntry(entry) {
  const dir = storeDir(entry.repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  const target = storePath(entry.repoRoot, entry.filePath, entry.sessionId);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    schemaVersion: BUFFER_SCHEMA_VERSION,
    filePath: entry.filePath,
    sessionId: entry.sessionId,
    content: entry.content,
    contentHash: entry.contentHash,
    version: entry.version,
    updatedAt: entry.updatedAt,
    eventType: entry.eventType,
    language: entry.language,
    dirty: entry.dirty,
    cursor: entry.cursor,
    selections: entry.selections,
  };
  fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
  fs.renameSync(tmp, target);
  return true;
}

/**
 * @param {OverlayEntry | { repoRoot: string, filePath: string, sessionId: string }} entry
 */
function removePersistedEntry(entry) {
  try { fs.unlinkSync(storePath(entry.repoRoot, entry.filePath, entry.sessionId)); }
  catch { /* missing overlay file is fine */ }
}

/**
 * @param {string} root
 */
function loadPersistedBuffers(root) {
  const resolved = path.resolve(root);
  if (LOADED_ROOTS.has(resolved)) return;
  LOADED_ROOTS.add(resolved);
  const dir = storeDir(resolved);
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return;
  }
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw?.schemaVersion !== BUFFER_SCHEMA_VERSION) continue;
      if (!isCanonicalRepoPath(raw.filePath)) continue;
      if (typeof raw.content !== "string") continue;
      if (Buffer.byteLength(raw.content, "utf8") > MAX_BUFFER_BYTES) continue;
      const sessionId = normalizeSession(raw.sessionId);
      const entry = makeEntry({
        root: resolved,
        filePath: raw.filePath,
        sessionId,
        content: raw.content,
        version: raw.version,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
        metadata: {
          eventType: raw.eventType,
          language: raw.language,
          dirty: raw.dirty,
          cursor: raw.cursor,
          selections: raw.selections,
        },
      });
      if (raw.contentHash && raw.contentHash !== entry.contentHash) continue;
      BUFFERS.set(keyOf(resolved, entry.filePath, sessionId), entry);
    } catch {
      // Ignore a torn/corrupt overlay cache file. The live worktree remains
      // authoritative and buffer.push can overwrite the cache later.
    }
  }
}

/**
 * @param {{ repoRoot?: string, versionId: string, params: BufferPushParams }} args
 * @returns {ReturnType<typeof okEnvelope<BufferPushData>> | ReturnType<typeof errorEnvelope>}
 */
export function bufferPush({ repoRoot, versionId, params }) {
  if (!params.filePath || !isCanonicalRepoPath(params.filePath)) {
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "invalid_path",
      message: `buffer.push requires a canonical repo-relative filePath, got ${params.filePath}`,
    });
  }
  if (typeof params.content !== "string") {
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "invalid_content",
      message: "buffer.push requires string content",
    });
  }
  const byteLength = Buffer.byteLength(params.content, "utf8");
  if (byteLength > MAX_BUFFER_BYTES) {
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "size_exceeded",
      message: `buffer.push refuses ${byteLength} bytes; max is ${MAX_BUFFER_BYTES}`,
    });
  }

  let root;
  try { root = requireRepoRoot(repoRoot); } catch (err) {
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "missing_repo_root",
      message: err?.message || String(err),
    });
  }

  const sessionId = normalizeSession(params.sessionId);
  loadPersistedBuffers(root);
  const key = keyOf(root, params.filePath, sessionId);
  const existing = BUFFERS.get(key);
  const incomingVersion = Number.isFinite(Number(params.version)) ? Number(params.version) : null;
  const incomingHash = sha256Hex(Buffer.from(params.content, "utf8"));
  if (
    existing
    && incomingVersion != null
    && existing.version != null
    && incomingVersion < existing.version
  ) {
    const stats = rootStats(root);
    stats.staleRejectedCount += 1;
    stats.lastRejectedAt = new Date().toISOString();
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "stale_buffer_version",
      message: `buffer.push rejected stale version ${incomingVersion}; current version is ${existing.version}`,
      details: {
        filePath: params.filePath,
        sessionId,
        incomingVersion,
        currentVersion: existing.version,
      },
    });
  }
  if (
    existing
    && incomingVersion != null
    && existing.version != null
    && incomingVersion === existing.version
    && incomingHash !== existing.contentHash
  ) {
    const stats = rootStats(root);
    stats.versionConflictRejectedCount += 1;
    stats.lastRejectedAt = new Date().toISOString();
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "buffer_version_conflict",
      message: `buffer.push rejected version ${incomingVersion} with different content than the existing buffer`,
      details: {
        filePath: params.filePath,
        sessionId,
        incomingVersion,
        currentVersion: existing.version,
        incomingContentHash: incomingHash,
        currentContentHash: existing.contentHash,
      },
    });
  }
  if (!existing && rootDraftCount(root) >= MAX_DRAFT_FILES) {
    const stats = rootStats(root);
    stats.draftLimitRejectedCount += 1;
    stats.lastRejectedAt = new Date().toISOString();
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "draft_limit_exceeded",
      message: `buffer.push refuses new live buffers after ${MAX_DRAFT_FILES} draft files`,
      details: {
        maxDraftFiles: MAX_DRAFT_FILES,
        sessionId,
        filePath: params.filePath,
      },
    });
  }
  const entry = makeEntry({
    root,
    filePath: params.filePath,
    sessionId,
    content: params.content,
    version: incomingVersion,
    metadata: {
      eventType: params.eventType,
      language: params.language,
      dirty: params.dirty,
      timestamp: params.timestamp,
      cursor: params.cursor,
      selections: params.selections,
    },
  });
  BUFFERS.set(key, entry);
  try {
    persistEntry(entry);
  } catch (err) {
    if (existing) BUFFERS.set(key, existing);
    else BUFFERS.delete(key);
    return errorEnvelope({
      action: ACTION_BUFFER_PUSH,
      versionId,
      code: "persist_failed",
      message: `buffer.push could not persist overlay: ${err?.message || String(err)}`,
    });
  }

  const data = {
    filePath: entry.filePath,
    sessionId,
    contentHash: entry.contentHash,
    byteLength,
    version: entry.version,
    parsed: entry.parsed,
    symbolCount: entry.symbolCount,
    persisted: true,
    eventType: entry.eventType,
    language: entry.language,
    dirty: entry.dirty,
    cursor: entry.cursor,
    selections: entry.selections,
    updatedAt: entry.updatedAt,
    warnings: bufferWarnings(entry, root),
    ...(existing ? { replaced: true } : {}),
  };
  recordLiveBufferEvent({
    repoRoot: root,
    filePath: entry.filePath,
    eventType: entry.eventType,
    parsed: entry.parsed,
    dirty: entry.dirty,
    updatedAt: entry.updatedAt,
  });
  return okEnvelope({
    action: ACTION_BUFFER_PUSH,
    versionId,
    data,
  });
}

/**
 * @param {{ repoRoot?: string, versionId: string, params: BufferStatusParams }} args
 * @returns {ReturnType<typeof okEnvelope<BufferStatusData>> | ReturnType<typeof errorEnvelope>}
 */
export function bufferStatus({ repoRoot, versionId, params }) {
  let root;
  try { root = requireRepoRoot(repoRoot); } catch (err) {
    return errorEnvelope({
      action: ACTION_BUFFER_STATUS,
      versionId,
      code: "missing_repo_root",
      message: err?.message || String(err),
    });
  }
  loadPersistedBuffers(root);
  const sessionId = params.sessionId ? normalizeSession(params.sessionId) : null;
  const filePath = params.filePath || null;
  if (filePath && !isCanonicalRepoPath(filePath)) {
    return errorEnvelope({
      action: ACTION_BUFFER_STATUS,
      versionId,
      code: "invalid_path",
      message: `buffer.status filePath must be canonical, got ${filePath}`,
    });
  }
  const rawEntries = [];
  for (const entry of BUFFERS.values()) {
    if (entry.repoRoot !== root) continue;
    if (sessionId && entry.sessionId !== sessionId) continue;
    if (filePath && entry.filePath !== filePath) continue;
    rawEntries.push(entry);
  }
  rawEntries.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.sessionId.localeCompare(b.sessionId));
  const entries = rawEntries.map((entry) => statusEntry(entry));
  entries.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.sessionId.localeCompare(b.sessionId));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.byteLength, 0);
  const dirtyCount = entries.filter((entry) => entry.dirty).length;
  const parsedCount = entries.filter((entry) => entry.parsed).length;
  const parseFailureCount = entries.filter((entry) => !entry.parsed).length;
  const syntaxErrorCount = rawEntries.filter((entry) => entry.parseResult?.hasError === true).length;
  const parseExceptionCount = rawEntries.filter((entry) => !entry.parsed && !entry.parseResult).length;
  const lastUpdatedAt = entries.reduce((latest, entry) => (
    !latest || entry.updatedAt > latest ? entry.updatedAt : latest
  ), /** @type {string | null} */ (null));
  const stats = rootStats(root);
  const warnings = statusWarnings(entries);
  return okEnvelope({
    action: ACTION_BUFFER_STATUS,
    versionId,
    data: {
      buffers: entries,
      total: entries.length,
      totalBytes,
      dirtyCount,
      parsedCount,
      parseFailureCount,
      syntaxErrorCount,
      parseExceptionCount,
      pendingParseCount: 0,
      draftLimit: MAX_DRAFT_FILES,
      draftLimitReached: rootDraftCount(root) >= MAX_DRAFT_FILES,
      staleRejectedCount: stats.staleRejectedCount,
      versionConflictRejectedCount: stats.versionConflictRejectedCount,
      draftLimitRejectedCount: stats.draftLimitRejectedCount,
      lastUpdatedAt,
      lastRejectedAt: stats.lastRejectedAt,
      warnings,
    },
  });
}

/**
 * @param {{ repoRoot?: string, versionId: string, params: BufferCheckpointParams }} args
 * @returns {ReturnType<typeof okEnvelope<BufferCheckpointData>> | ReturnType<typeof errorEnvelope>}
 */
export function bufferCheckpoint({ repoRoot, versionId, params }) {
  if (!params.filePath || !isCanonicalRepoPath(params.filePath)) {
    return errorEnvelope({
      action: ACTION_BUFFER_CHECKPOINT,
      versionId,
      code: "invalid_path",
      message: `buffer.checkpoint requires a canonical repo-relative filePath, got ${params.filePath}`,
    });
  }
  let root;
  try { root = requireRepoRoot(repoRoot); } catch (err) {
    return errorEnvelope({
      action: ACTION_BUFFER_CHECKPOINT,
      versionId,
      code: "missing_repo_root",
      message: err?.message || String(err),
    });
  }
  const sessionId = normalizeSession(params.sessionId);
  loadPersistedBuffers(root);
  const key = keyOf(root, params.filePath, sessionId);
  const entry = BUFFERS.get(key);
  if (!entry) {
    return okEnvelope({
      action: ACTION_BUFFER_CHECKPOINT,
      versionId,
      data: {
        filePath: params.filePath,
        sessionId,
        cleared: false,
        wroteToDisk: false,
        diskMatches: false,
        contentHash: null,
      },
    });
  }

  const abs = path.resolve(root, params.filePath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return errorEnvelope({
      action: ACTION_BUFFER_CHECKPOINT,
      versionId,
      code: "invalid_path",
      message: "buffer.checkpoint path escapes repo root",
    });
  }

  let wroteToDisk = false;
  if (params.writeToDisk) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, entry.content, "utf8");
    wroteToDisk = true;
  }
  const diskMatches = diskHash(abs) === entry.contentHash;
  const shouldClear = diskMatches || !!params.clear || wroteToDisk;
  if (shouldClear) {
    BUFFERS.delete(key);
    removePersistedEntry(entry);
  }

  const data = {
    filePath: params.filePath,
    sessionId,
    cleared: shouldClear,
    wroteToDisk,
    diskMatches,
    contentHash: entry.contentHash,
  };
  recordLiveCheckpoint({
    repoRoot: root,
    filePath: params.filePath,
    cleared: shouldClear,
    wroteToDisk,
    diskMatches,
  });
  return okEnvelope({
    action: ACTION_BUFFER_CHECKPOINT,
    versionId,
    data,
  });
}

/**
 * @param {{ repoRoot?: string, sessionId?: string, baseReadFile: ReadFile }} args
 * @returns {ReadFile}
 */
export function makeOverlayReadFile({ repoRoot, sessionId, baseReadFile }) {
  if (!repoRoot) return baseReadFile;
  const root = path.resolve(repoRoot);
  const sid = normalizeSession(sessionId);
  return (repoRelPath) => {
    loadPersistedBuffers(root);
    const entry = BUFFERS.get(keyOf(root, repoRelPath, sid))
      || BUFFERS.get(keyOf(root, repoRelPath, DEFAULT_SESSION));
    if (entry) return entry.content;
    return baseReadFile(repoRelPath);
  };
}

/**
 * @param {{ repoRoot?: string, sessionId?: string, filePath?: string }} args
 * @returns {{ entry: OverlayEntry, symbol: ViewSymbol }[]}
 */
export function getOverlaySymbols({ repoRoot, sessionId, filePath } = {}) {
  const entries = getOverlayEntries({ repoRoot, sessionId, filePath });
  /** @type {{ entry: OverlayEntry, symbol: ViewSymbol }[]} */
  const out = [];
  let globalId = -1;
  for (const entry of entries) {
    const symbols = entry.parseResult?.symbols || [];
    for (const symbol of symbols) {
      out.push({
        entry,
        symbol: /** @type {ViewSymbol} */ ({
          global_id: globalId--,
          content_hash: symbol.content_hash,
          local_id: symbol.local_id,
          kind: symbol.kind,
          name: symbol.name,
          qualified_name: symbol.qualified_name,
          repo_rel_path: symbol.repo_rel_path,
          range_start: symbol.range_start,
          range_end: symbol.range_end,
          range_start_line: /** @type {any} */ (symbol).range_start_line,
          range_end_line: /** @type {any} */ (symbol).range_end_line,
          signature_hash: symbol.signature_hash,
          visibility: symbol.visibility,
          doc: symbol.doc,
          lang: symbol.lang,
        }),
      });
    }
  }
  return out;
}

/**
 * @param {{ repoRoot?: string, sessionId?: string, filePath?: string }} args
 * @returns {OverlayEntry[]}
 */
export function getOverlayEntries({ repoRoot, sessionId, filePath } = {}) {
  if (!repoRoot) return [];
  const root = path.resolve(repoRoot);
  loadPersistedBuffers(root);
  const sid = sessionId ? normalizeSession(sessionId) : null;
  /** @type {Map<string, OverlayEntry>} */
  const byFile = new Map();
  for (const entry of BUFFERS.values()) {
    if (entry.repoRoot !== root) continue;
    if (filePath && entry.filePath !== filePath) continue;
    if (sid) {
      if (entry.sessionId !== DEFAULT_SESSION && entry.sessionId !== sid) continue;
      const existing = byFile.get(entry.filePath);
      if (!existing || entry.sessionId === sid) byFile.set(entry.filePath, entry);
    } else {
      if (entry.sessionId !== DEFAULT_SESSION) continue;
      byFile.set(entry.filePath, entry);
    }
  }
  return [...byFile.values()].filter((entry) => !!entry.parseResult);
}

/**
 * @param {{ repoRoot?: string, sessionId?: string, symbolId?: string }} args
 * @returns {{ entry: OverlayEntry, symbol: ViewSymbol } | null}
 */
export function findOverlaySymbol({ repoRoot, sessionId, symbolId }) {
  const parsed = parseSymbolId(symbolId);
  if (!parsed) return null;
  return getOverlaySymbols({ repoRoot, sessionId }).find(({ symbol }) =>
    symbol.content_hash === parsed.content_hash && symbol.local_id === parsed.local_id
  ) || null;
}

/**
 * @param {{ repoRoot?: string, sessionId?: string, ref?: { name?: string, file?: string, kind?: string } }} args
 * @returns {{ entry: OverlayEntry, symbol: ViewSymbol } | null}
 */
export function findOverlaySymbolByRef({ repoRoot, sessionId, ref }) {
  if (!ref?.name) return null;
  const candidates = getOverlaySymbols({ repoRoot, sessionId, filePath: ref.file });
  return candidates.find(({ symbol }) =>
    symbol.name === ref.name && (!ref.kind || symbol.kind === ref.kind)
  ) || null;
}

/**
 * @returns {void}
 */
export function __resetBufferRegistryForTests() {
  BUFFERS.clear();
  LOADED_ROOTS.clear();
  ROOT_STATS.clear();
}

/**
 * @param {OverlayEntry} entry
 * @returns {BufferStatusEntry}
 */
function statusEntry(entry) {
  return {
    filePath: entry.filePath,
    sessionId: entry.sessionId,
    contentHash: entry.contentHash,
    byteLength: entry.byteLength,
    version: entry.version,
    diskMatches: diskHash(path.join(entry.repoRoot, entry.filePath)) === entry.contentHash,
    persisted: fs.existsSync(storePath(entry.repoRoot, entry.filePath, entry.sessionId)),
    updatedAt: entry.updatedAt,
    parsed: entry.parsed,
    symbolCount: entry.symbolCount,
    eventType: entry.eventType,
    language: entry.language,
    dirty: entry.dirty,
    cursor: entry.cursor,
    selections: entry.selections,
    warnings: bufferWarnings(entry, entry.repoRoot),
  };
}

/**
 * @param {OverlayEntry} entry
 * @param {string} root
 */
function bufferWarnings(entry, root) {
  const warnings = [];
  if (entry.byteLength >= LARGE_BUFFER_WARNING_BYTES) {
    warnings.push(`Large live buffer: ${entry.byteLength} bytes.`);
  }
  if (!entry.parsed) {
    warnings.push(entry.parseResult?.hasError
      ? "Buffer stored but parser reported syntax errors; ATLAS symbols are partial."
      : "Buffer stored but parser did not produce ATLAS symbols.");
  }
  if (rootDraftCount(root) >= MAX_DRAFT_FILES) {
    warnings.push(`Live index draft limit reached (${MAX_DRAFT_FILES} files).`);
  }
  return warnings;
}

/**
 * @param {string} root
 * @returns {number}
 */
function rootDraftCount(root) {
  return [...BUFFERS.values()].filter((candidate) => candidate.repoRoot === root).length;
}

/**
 * @param {Array<{ warnings?: string[] }>} entries
 */
function statusWarnings(entries) {
  const out = [];
  for (const entry of entries) {
    for (const warning of entry.warnings || []) {
      if (!out.includes(warning)) out.push(warning);
    }
  }
  return out;
}

function normalizeEventType(value) {
  const text = String(value || "change").trim();
  return ["open", "change", "save", "close", "checkpoint"].includes(text) ? text : "change";
}

function normalizeLanguage(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 40) : null;
}

function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * @param {unknown} value
 * @returns {Record<string, number> | null}
 */
function normalizeCursor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const line = Number(/** @type {any} */ (value).line);
  const column = Number(/** @type {any} */ (value).column);
  /** @type {Record<string, number>} */
  const out = {};
  if (Number.isFinite(line) && line >= 0) out.line = Math.floor(line);
  if (Number.isFinite(column) && column >= 0) out.column = Math.floor(column);
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @param {unknown} value
 * @returns {Array<Record<string, number>>}
 */
function normalizeSelections(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((selection) => {
    /** @type {Record<string, number>} */
    const out = {};
    if (selection && typeof selection === "object" && !Array.isArray(selection)) {
      for (const key of ["startLine", "startColumn", "endLine", "endColumn"]) {
        const n = Number(/** @type {Record<string, unknown>} */ (selection)[key]);
        if (Number.isFinite(n) && n >= 0) out[key] = Math.floor(n);
      }
    }
    return out;
  }).filter((selection) => Object.keys(selection).length > 0);
}

/**
 * @param {string} absPath
 * @returns {string | null}
 */
function diskHash(absPath) {
  try {
    return sha256Hex(fs.readFileSync(absPath));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} id
 * @returns {{ content_hash: string, local_id: number } | null}
 */
function parseSymbolId(id) {
  if (typeof id !== "string") return null;
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) return null;
  const content_hash = id.slice(0, idx);
  const local_id = Number(id.slice(idx + 1));
  if (!/^[0-9a-f]{64}$/.test(content_hash) || !Number.isInteger(local_id) || local_id < 0) {
    return null;
  }
  return { content_hash, local_id };
}
