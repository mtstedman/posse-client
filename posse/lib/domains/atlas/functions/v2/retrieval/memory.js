// @ts-check
//
// Native ATLAS v2 memory handlers. These replace the original ATLAS-MCP memory
// graph with ledger-owned storage while keeping the public action names stable.

import { randomUUID } from "crypto";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { sha256Hex } from "../hash.js";
import { normalizeRepoPath } from "../paths.js";
import { parseAtlasSymbolId, sanitizeAtlasSymbolIdList } from "../symbol-id.js";
import { getEffectivePolicy } from "./policy.js";
import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";

const MEMORY_TYPES = new Set([
  "decision",
  "bugfix",
  "task_context",
  "pattern",
  "convention",
  "architecture",
  "performance",
  "security",
]);

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryStoreParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memoryStore({ versionId, params, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("memory.store", versionId);
  if (!getEffectivePolicy(ledger, effectiveRepo(repoId, params.repoId)).memoryEnabled) {
    return memoryDisabled("memory.store", versionId);
  }

  const type = normalizeMemoryType(params.type);
  if (!type) {
    return errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_memory_type",
      message: "memory.store requires a supported memory type",
    });
  }
  const title = cleanString(params.title, 120);
  const content = cleanString(params.content, 50_000);
  if (!title || !content) {
    return errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_memory",
      message: "memory.store requires non-empty title and content",
    });
  }

  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const tags = normalizeTags(params.tags);
  let symbolIds;
  try {
    symbolIds = sanitizeAtlasSymbolIdList(params.symbolIds || [], 100, "memory.store symbolIds");
  } catch (err) {
    return errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_symbol_id",
      message: err?.message || String(err),
    });
  }
  const fileRelPaths = normalizePaths(params.fileRelPaths || []);
  const confidence = clampNumber(params.confidence, 0, 1, 0.5);
  const providedId = cleanMemoryId(params.memoryId);
  const contentHash = memoryContentHash({ type, title, content, tags, symbolIds, fileRelPaths });
  const memoryId = providedId || `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const existing = providedId ? findMemoryById(db, memoryId) : null;
  if (existing && existing.repo_id !== effectiveRepoId) {
    return errorEnvelope({
      action: "memory.store",
      versionId,
      code: "memory_id_conflict",
      message: `Memory ${memoryId} already belongs to a different repository`,
    });
  }
  const sameIdSameContent = !!(existing && existing.content_hash === contentHash);
  const existingByHash = sameIdSameContent ? null : findActiveMemoryByHash(db, effectiveRepoId, contentHash);
  const duplicateToReplace = existing && existingByHash && existingByHash.memory_id !== memoryId
    ? existingByHash.memory_id
    : null;
  if (existingByHash && existingByHash.memory_id !== memoryId) {
    if (providedId && !existing) {
      return errorEnvelope({
        action: "memory.store",
        versionId,
        code: "duplicate_memory_content",
        message: `Memory content already exists as ${existingByHash.memory_id}`,
      });
    }
    if (!providedId) return okEnvelope({
      action: "memory.store",
      versionId,
      data: {
        ok: true,
        memoryId: existingByHash.memory_id,
        memory_id: existingByHash.memory_id,
        created: false,
        deduplicated: true,
      },
    });
  }

  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    if (duplicateToReplace) {
      db.prepare(
        "UPDATE memories SET deleted = 1, deleted_at = ?, updated_at = ? WHERE memory_id = ?",
      ).run(now, now, duplicateToReplace);
    }
    db.prepare(
      `INSERT INTO memories
         (memory_id, repo_id, type, title, content, tags_json, confidence,
          content_hash, stale, deleted, created_at, updated_at, deleted_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, 'agent')
       ON CONFLICT(memory_id) DO UPDATE SET
          type = excluded.type,
          title = excluded.title,
          content = excluded.content,
          tags_json = excluded.tags_json,
          confidence = excluded.confidence,
          content_hash = excluded.content_hash,
          stale = 0,
          deleted = 0,
          updated_at = excluded.updated_at,
          deleted_at = NULL`,
    ).run(
      memoryId,
      effectiveRepoId,
      type,
      title,
      content,
      JSON.stringify(tags),
      confidence,
      contentHash,
      existing?.created_at || now,
      now,
    );
    replaceMemoryLinks(db, memoryId, symbolIds, fileRelPaths);
  });
  try {
    txn();
  } catch (err) {
    return errorEnvelope({
      action: "memory.store",
      versionId,
      code: "memory_store_failed",
      message: err?.message || String(err),
    });
  }
  getRetrievalCache().invalidateAll();

  return okEnvelope({
    action: "memory.store",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      created: !existing,
      deduplicated: false,
      ...(duplicateToReplace ? { mergedDuplicateMemoryId: duplicateToReplace } : {}),
    },
  });
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryQueryParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memoryQuery({ versionId, params, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("memory.query", versionId);
  if (!getEffectivePolicy(ledger, effectiveRepo(repoId, params.repoId)).memoryEnabled) {
    return memoryDisabled("memory.query", versionId);
  }
  const limit = clampInt(params.limit, 1, 100, 20);
  const offset = clampInt(params.offset, 0, 10_000, 0);
  const rows = candidateRows(db, effectiveRepo(repoId, params.repoId), {
    includeDeleted: false,
    query: params.query,
  });
  const filtered = filterRows(db, rows, params);
  const scored = filtered.map((row) => hydrateMemory(db, row, {
    query: params.query,
    symbolIds: params.symbolIds,
    fileRelPaths: params.fileRelPaths,
  }));
  sortMemories(scored, params.sortBy || (params.query ? "score" : "recency"));
  const page = scored.slice(offset, offset + limit);
  return okEnvelope({
    action: "memory.query",
    versionId,
    data: {
      repoId: effectiveRepo(repoId, params.repoId),
      memories: page,
      total: scored.length,
      hasMore: offset + limit < scored.length,
      nextOffset: offset + limit < scored.length ? offset + limit : null,
    },
  });
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryRemoveParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memoryRemove({ versionId, params, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("memory.remove", versionId);
  if (!getEffectivePolicy(ledger, effectiveRepo(repoId, params.repoId)).memoryEnabled) {
    return memoryDisabled("memory.remove", versionId);
  }
  const memoryId = cleanMemoryId(params.memoryId);
  if (!memoryId) {
    return errorEnvelope({
      action: "memory.remove",
      versionId,
      code: "invalid_memory_id",
      message: "memory.remove requires memoryId",
    });
  }
  const row = findMemoryById(db, memoryId);
  if (!row || Number(row.deleted || 0) === 1 || row.repo_id !== effectiveRepo(repoId, params.repoId)) {
    return errorEnvelope({
      action: "memory.remove",
      versionId,
      code: "memory_not_found",
      message: `Memory ${memoryId} was not found`,
    });
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE memories SET deleted = 1, deleted_at = ?, updated_at = ? WHERE memory_id = ?").run(now, now, memoryId);
  getRetrievalCache().invalidateAll();
  return okEnvelope({
    action: "memory.remove",
    versionId,
    data: { ok: true, memoryId, memory_id: memoryId },
  });
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemorySurfaceParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memorySurface({ versionId, params, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("memory.surface", versionId);
  if (!getEffectivePolicy(ledger, effectiveRepo(repoId, params.repoId)).memoryEnabled) {
    return memoryDisabled("memory.surface", versionId);
  }
  const limit = clampInt(params.limit, 1, 50, 6);
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const rows = candidateRows(db, effectiveRepoId, { includeDeleted: false });
  const filtered = filterRows(db, rows, params);
  const surfaced = filtered
    .map((row) => hydrateMemory(db, row, {
      symbolIds: params.symbolIds,
      fileRelPaths: params.fileRelPaths,
      taskType: params.taskType,
    }))
    .filter((memory) => memory.score > 0 || hasNoSurfaceCriteria(params));
  sortMemories(surfaced, "score");
  return okEnvelope({
    action: "memory.surface",
    versionId,
    data: {
      repoId: effectiveRepoId,
      memories: surfaced.slice(0, limit),
      total: surfaced.length,
    },
  });
}

function ledgerDb(ledger) {
  return typeof /** @type {any} */ (ledger)?._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
}

function ledgerUnavailable(action, versionId) {
  return errorEnvelope({
    action: /** @type {any} */ (action),
    versionId,
    code: "ledger_unavailable",
    message: `${action} requires a ledger-backed ATLAS context`,
  });
}

function memoryDisabled(action, versionId) {
  return errorEnvelope({
    action: /** @type {any} */ (action),
    versionId,
    code: "memory_disabled",
    message: "Native ATLAS v2 memory is disabled by policy",
  });
}

function normalizeMemoryType(value) {
  const raw = String(value || "").trim().toLowerCase();
  return MEMORY_TYPES.has(raw) ? raw : null;
}

function effectiveRepo(ctxRepoId, paramRepoId) {
  return cleanString(paramRepoId || ctxRepoId || "default", 200) || "default";
}

function cleanString(value, maxLen) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function cleanMemoryId(value) {
  const text = cleanString(value, 120);
  if (!text) return "";
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text : "";
}

function normalizeTags(values) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const tag = cleanString(raw, 64).toLowerCase();
    if (!tag || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= 20) break;
  }
  return out;
}

function normalizePaths(values) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const p = normalizeRepoPath(String(raw || ""));
    if (!p || out.includes(p)) continue;
    out.push(p);
    if (out.length >= 100) break;
  }
  return out;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function memoryContentHash({ type, title, content, tags, symbolIds, fileRelPaths }) {
  return sha256Hex(JSON.stringify({
    type,
    title,
    content,
    tags: [...tags].sort(),
    symbolIds: [...symbolIds].sort(),
    fileRelPaths: [...fileRelPaths].sort(),
  }));
}

function findActiveMemoryByHash(db, repoId, contentHash) {
  return db.prepare(
    "SELECT * FROM memories WHERE repo_id = ? AND content_hash = ? AND deleted = 0 LIMIT 1",
  ).get(repoId, contentHash);
}

function findMemoryById(db, memoryId) {
  return db.prepare("SELECT * FROM memories WHERE memory_id = ? LIMIT 1").get(memoryId);
}

function replaceMemoryLinks(db, memoryId, symbolIds, fileRelPaths) {
  db.prepare("DELETE FROM memory_symbol_links WHERE memory_id = ?").run(memoryId);
  db.prepare("DELETE FROM memory_file_links WHERE memory_id = ?").run(memoryId);
  const symIns = db.prepare(
    "INSERT OR IGNORE INTO memory_symbol_links(memory_id, content_hash, local_id) VALUES(?, ?, ?)",
  );
  for (const symbolId of symbolIds) {
    const parsed = parseAtlasSymbolId(symbolId);
    if (!parsed) continue;
    symIns.run(memoryId, parsed.content_hash, parsed.local_id);
  }
  const fileIns = db.prepare(
    "INSERT OR IGNORE INTO memory_file_links(memory_id, repo_rel_path) VALUES(?, ?)",
  );
  for (const repoRelPath of fileRelPaths) fileIns.run(memoryId, repoRelPath);
}

function candidateRows(db, repoId, { includeDeleted = false, query = "" } = {}) {
  const ftsRows = query ? candidateRowsByFts(db, repoId, { query, includeDeleted }) : null;
  if (ftsRows) return ftsRows;
  const deletedSql = includeDeleted ? "" : "AND deleted = 0";
  return db.prepare(
    `SELECT * FROM memories
     WHERE repo_id = ? ${deletedSql}
     ORDER BY updated_at DESC
     LIMIT 5000`,
  ).all(repoId);
}

function candidateRowsByFts(db, repoId, { query, includeDeleted }) {
  if (!tableExists(db, "memories_fts")) return null;
  const match = ftsMatchQuery(query);
  if (!match) return null;
  const deletedSql = includeDeleted ? "" : "AND m.deleted = 0";
  try {
    return db.prepare(
      `SELECT m.*, bm25(memories_fts, 4.0, 3.0, 1.0) AS _fts_rank, 1 AS _fts_match
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
       WHERE memories_fts MATCH ?
         AND m.repo_id = ?
         ${deletedSql}
       ORDER BY _fts_rank ASC, m.updated_at DESC
       LIMIT 5000`,
    ).all(match, repoId);
  } catch {
    return null;
  }
}

function filterRows(db, rows, params = {}) {
  const types = new Set((Array.isArray(params.types) ? params.types : [])
    .map((t) => normalizeMemoryType(t))
    .filter(Boolean));
  const tags = normalizeTags(params.tags || []);
  const symbols = safeSymbolIds(params.symbolIds || []);
  const files = normalizePaths(params.fileRelPaths || []);
  const query = cleanString(params.query, 1000).toLowerCase();
  const queryTokens = tokenize(query);
  return rows.filter((row) => {
    if (types.size > 0 && !types.has(row.type)) return false;
    if (params.staleOnly && Number(row.stale || 0) !== 1) return false;
    const rowTags = parseJsonArray(row.tags_json);
    if (tags.length > 0 && !tags.every((tag) => rowTags.includes(tag))) return false;
    if (query && Number(row._fts_match || 0) !== 1) {
      const text = memorySearchText(row, rowTags);
      if (!queryTokens.every((token) => text.includes(token))) return false;
    }
    if (symbols.length > 0 && !hasAnySymbolLink(db, row.memory_id, symbols)) return false;
    if (files.length > 0 && !hasAnyFileLink(db, row.memory_id, files)) return false;
    return true;
  });
}

function safeSymbolIds(values) {
  try {
    return sanitizeAtlasSymbolIdList(values, 500, "memory.surface symbolIds");
  } catch {
    return [];
  }
}

function hasAnySymbolLink(db, memoryId, symbolIds) {
  const stmt = db.prepare(
    `SELECT 1 FROM memory_symbol_links
     WHERE memory_id = ? AND content_hash = ? AND local_id = ?
     LIMIT 1`,
  );
  for (const symbolId of symbolIds) {
    const parsed = parseAtlasSymbolId(symbolId);
    if (parsed && stmt.get(memoryId, parsed.content_hash, parsed.local_id)) return true;
  }
  return false;
}

function hasAnyFileLink(db, memoryId, fileRelPaths) {
  const stmt = db.prepare(
    "SELECT 1 FROM memory_file_links WHERE memory_id = ? AND repo_rel_path = ? LIMIT 1",
  );
  for (const file of fileRelPaths) if (stmt.get(memoryId, file)) return true;
  return false;
}

function hydrateMemory(db, row, criteria = {}) {
  const tags = parseJsonArray(row.tags_json);
  const linkedSymbols = db.prepare(
    "SELECT content_hash, local_id FROM memory_symbol_links WHERE memory_id = ? ORDER BY content_hash, local_id",
  ).all(row.memory_id).map((s) => `${s.content_hash}:${s.local_id}`);
  const fileRelPaths = db.prepare(
    "SELECT repo_rel_path FROM memory_file_links WHERE memory_id = ? ORDER BY repo_rel_path",
  ).all(row.memory_id).map((f) => f.repo_rel_path);
  const matchedSymbols = (safeSymbolIds(criteria.symbolIds || [])).filter((s) => linkedSymbols.includes(s));
  const matchedFiles = normalizePaths(criteria.fileRelPaths || []).filter((f) => fileRelPaths.includes(f));
  const score = memoryScore(row, {
    tags,
    linkedSymbols,
    fileRelPaths,
    matchedSymbols,
    matchedFiles,
    query: criteria.query,
    taskType: criteria.taskType,
  });
  return {
    memoryId: row.memory_id,
    memory_id: row.memory_id,
    repoId: row.repo_id,
    type: row.type,
    title: row.title,
    content: row.content,
    tags,
    confidence: Number(row.confidence || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stale: Number(row.stale || 0) === 1,
    linkedSymbols,
    symbolIds: linkedSymbols,
    fileRelPaths,
    score,
    matchedSymbols,
    matchedFiles,
  };
}

function memoryScore(row, detail) {
  let score = 0;
  score += Number(row.confidence || 0) || 0;
  score += recencyScore(row.updated_at);
  score += detail.matchedSymbols.length * 2;
  score += detail.matchedFiles.length;
  if (detail.taskType && row.type === detail.taskType) score += 0.75;
  const query = cleanString(detail.query, 1000).toLowerCase();
  if (query) {
    const text = memorySearchText(row, detail.tags);
    for (const token of tokenize(query)) {
      if (text.includes(token)) score += 0.5;
    }
    if (Number(row._fts_match || 0) === 1) score += 1.25;
  }
  return Math.round(score * 1000) / 1000;
}

function recencyScore(value) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / 86_400_000);
  return Math.exp(-ageDays / 45);
}

function memorySearchText(row, tags) {
  return `${row.title || ""}\n${row.content || ""}\n${tags.join(" ")}`.toLowerCase();
}

function tokenize(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
}

function ftsMatchQuery(text) {
  const tokens = tokenize(text).slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `${token.replace(/"/g, "\"\"")}*`).join(" OR ");
}

function tableExists(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  } catch {
    return false;
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map((v) => String(v)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function sortMemories(memories, sortBy) {
  memories.sort((a, b) => {
    if (sortBy === "confidence") {
      return (Number(b.confidence || 0) - Number(a.confidence || 0))
        || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    }
    if (sortBy === "recency") {
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    }
    return (Number(b.score || 0) - Number(a.score || 0))
      || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });
}

function hasNoSurfaceCriteria(params = {}) {
  return !(Array.isArray(params.symbolIds) && params.symbolIds.length > 0)
    && !(Array.isArray(params.fileRelPaths) && params.fileRelPaths.length > 0)
    && !params.taskType;
}
