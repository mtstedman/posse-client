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
  const policy = getEffectivePolicy(ledger, effectiveRepo(repoId, params.repoId));
  if (!policy.memoryEnabled) {
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

  // Exact-hash dedupe misses rewordings of the same knowledge. For
  // auto-generated ids (agent "just remember this" writes) a conservative
  // near-duplicate check folds the write into the existing memory instead of
  // accumulating parallel variants. Explicit ids are intentional updates and
  // are never redirected.
  if (!providedId && !existing) {
    const nearDuplicate = findNearDuplicateMemory(db, effectiveRepoId, type, title, content);
    if (nearDuplicate) {
      return okEnvelope({
        action: "memory.store",
        versionId,
        data: {
          ok: true,
          memoryId: nearDuplicate.memory_id,
          memory_id: nearDuplicate.memory_id,
          created: false,
          deduplicated: true,
          nearDuplicate: true,
        },
      });
    }
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
          stale_reason = NULL,
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
  sweepStaleMemories(db, effectiveRepoId, policy);
  enforceMemoryCap(db, effectiveRepoId, policy, now);
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
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const policy = getEffectivePolicy(ledger, effectiveRepoId);
  if (!policy.memoryEnabled) {
    return memoryDisabled("memory.query", versionId);
  }
  sweepStaleMemories(db, effectiveRepoId, policy);
  const limit = clampInt(params.limit, 1, 100, 20);
  const offset = clampInt(params.offset, 0, 10_000, 0);
  const rows = candidateRows(db, effectiveRepoId, {
    includeDeleted: false,
    query: params.query,
  });
  const links = fetchMemoryLinks(db, rows.map((row) => row.memory_id));
  const filtered = filterRows(rows, params, links, { anchorMode: "all" });
  const scored = filtered.map((row) => hydrateMemory(row, links, {
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
      repoId: effectiveRepoId,
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

const MEMORY_FLAG_REASONS = new Set(["contradicted", "anchors_missing", "manual"]);

/**
 * Evidence-based staleness: flag a memory stale WITH a reason instead of
 * deleting it. 'contradicted' (assessment/work proved it wrong) also stamps
 * contradicted_at and bumps contradiction_count. Flagged memories stop
 * surfacing proactively but stay queryable and correctable — suppression
 * stays a deliberate memory.remove.
 *
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryFlagParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memoryFlag({ versionId, params, ledger, repoId }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("memory.flag", versionId);
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  if (!getEffectivePolicy(ledger, effectiveRepoId).memoryEnabled) {
    return memoryDisabled("memory.flag", versionId);
  }
  const memoryId = cleanMemoryId(params.memoryId);
  if (!memoryId) {
    return errorEnvelope({
      action: "memory.flag",
      versionId,
      code: "invalid_memory_id",
      message: "memory.flag requires memoryId",
    });
  }
  const reason = String(params.reason || "").trim().toLowerCase();
  if (!MEMORY_FLAG_REASONS.has(reason)) {
    return errorEnvelope({
      action: "memory.flag",
      versionId,
      code: "invalid_flag_reason",
      message: `memory.flag reason must be one of: ${[...MEMORY_FLAG_REASONS].join(", ")}`,
    });
  }
  const row = findMemoryById(db, memoryId);
  if (!row || Number(row.deleted || 0) === 1 || row.repo_id !== effectiveRepoId) {
    return errorEnvelope({
      action: "memory.flag",
      versionId,
      code: "memory_not_found",
      message: `Memory ${memoryId} was not found`,
    });
  }
  const now = new Date().toISOString();
  flagMemoryStale(db, memoryId, reason, now);
  getRetrievalCache().invalidateAll();
  const updated = findMemoryById(db, memoryId);
  return okEnvelope({
    action: "memory.flag",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      stale: true,
      staleReason: reason,
      contradictionCount: Number(updated?.contradiction_count || 0),
      detail: cleanString(params.detail, 500) || undefined,
    },
  });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} memoryId
 * @param {string} reason
 * @param {string} now
 */
function flagMemoryStale(db, memoryId, reason, now) {
  // updated_at is deliberately NOT bumped: it drives the recency score and
  // the age sweep, and flagging a memory must not make it look fresher.
  if (reason === "contradicted") {
    db.prepare(
      `UPDATE memories
       SET stale = 1, stale_reason = ?, contradicted_at = ?,
           contradiction_count = contradiction_count + 1
       WHERE memory_id = ?`,
    ).run(reason, now, memoryId);
  } else {
    db.prepare(
      "UPDATE memories SET stale = 1, stale_reason = ? WHERE memory_id = ?",
    ).run(reason, memoryId);
  }
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemorySurfaceParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 *   view?: import("../contracts/api.js").View | null,
 * }} args
 */
export function memorySurface({ versionId, params, ledger, repoId, view = null }) {
  const db = ledgerDb(ledger);
  if (!db) return ledgerUnavailable("memory.surface", versionId);
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const policy = getEffectivePolicy(ledger, effectiveRepoId);
  if (!policy.memoryEnabled) {
    return memoryDisabled("memory.surface", versionId);
  }
  sweepStaleMemories(db, effectiveRepoId, policy);
  const limit = clampInt(params.limit, 1, 50, 6);
  const rows = candidateRows(db, effectiveRepoId, { includeDeleted: false });
  const links = fetchMemoryLinks(db, rows.map((row) => row.memory_id));
  // Surfacing is proactive: a memory anchored to any of the provided symbols
  // OR files is relevant, and stale memories never surface on their own.
  let filtered = filterRows(rows, params, links, { anchorMode: "any", excludeStale: true });
  filtered = applyAnchorEvidence(db, view, filtered, links);
  const surfaced = filtered.map((row) => hydrateMemory(row, links, {
    symbolIds: params.symbolIds,
    fileRelPaths: params.fileRelPaths,
    taskType: params.taskType,
  }));
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

// High bar on purpose: only near-verbatim rewordings fold into an existing
// memory. Distinct lessons that merely share vocabulary must stay separate.
const NEAR_DUPLICATE_JACCARD = 0.9;

function findNearDuplicateMemory(db, repoId, type, title, content) {
  const target = new Set(tokenize(`${title}\n${content}`));
  if (target.size === 0) return null;
  const rows = db.prepare(
    `SELECT memory_id, title, content FROM memories
     WHERE repo_id = ? AND type = ? AND deleted = 0
     ORDER BY updated_at DESC
     LIMIT 200`,
  ).all(repoId, type);
  for (const row of rows) {
    const candidate = new Set(tokenize(`${row.title || ""}\n${row.content || ""}`));
    if (jaccardSimilarity(target, candidate) >= NEAR_DUPLICATE_JACCARD) return row;
  }
  return null;
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Keep each repo's active memory count under policy.memoryMaxPerRepo by
 * soft-deleting the least valuable rows (stale first, then lowest confidence,
 * then oldest). The just-written memory has the newest updated_at, so it is
 * only evicted if everything else outranks it.
 */
function enforceMemoryCap(db, repoId, policy, now) {
  const cap = clampInt(policy?.memoryMaxPerRepo, 0, 100_000, 0);
  if (cap <= 0) return;
  const count = db.prepare(
    "SELECT COUNT(*) AS c FROM memories WHERE repo_id = ? AND deleted = 0",
  ).get(repoId)?.c || 0;
  if (count <= cap) return;
  const victims = db.prepare(
    `SELECT memory_id FROM memories
     WHERE repo_id = ? AND deleted = 0
     ORDER BY stale DESC, confidence ASC, updated_at ASC
     LIMIT ?`,
  ).all(repoId, count - cap);
  const evict = db.prepare(
    "UPDATE memories SET deleted = 1, deleted_at = ?, updated_at = ? WHERE memory_id = ?",
  );
  for (const victim of victims) evict.run(now, now, victim.memory_id);
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

/**
 * Batch-fetch symbol/file links for a set of memories in chunked IN queries so
 * filtering and hydration never issue per-row lookups.
 */
function fetchMemoryLinks(db, memoryIds) {
  const symbolsById = new Map();
  const filesById = new Map();
  const unique = [...new Set(memoryIds)];
  for (let start = 0; start < unique.length; start += 400) {
    const chunk = unique.slice(start, start + 400);
    const placeholders = chunk.map(() => "?").join(", ");
    const symbolRows = db.prepare(
      `SELECT memory_id, content_hash, local_id FROM memory_symbol_links
       WHERE memory_id IN (${placeholders})
       ORDER BY content_hash, local_id`,
    ).all(...chunk);
    for (const row of symbolRows) {
      if (!symbolsById.has(row.memory_id)) symbolsById.set(row.memory_id, []);
      symbolsById.get(row.memory_id).push(`${row.content_hash}:${row.local_id}`);
    }
    const fileRows = db.prepare(
      `SELECT memory_id, repo_rel_path FROM memory_file_links
       WHERE memory_id IN (${placeholders})
       ORDER BY repo_rel_path`,
    ).all(...chunk);
    for (const row of fileRows) {
      if (!filesById.has(row.memory_id)) filesById.set(row.memory_id, []);
      filesById.get(row.memory_id).push(row.repo_rel_path);
    }
  }
  return { symbolsById, filesById };
}

function filterRows(rows, params = {}, links, { anchorMode = "all", excludeStale = false } = {}) {
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
    if (excludeStale && Number(row.stale || 0) === 1) return false;
    if (params.staleOnly && Number(row.stale || 0) !== 1) return false;
    const rowTags = parseJsonArray(row.tags_json);
    if (tags.length > 0 && !tags.every((tag) => rowTags.includes(tag))) return false;
    if (query && Number(row._fts_match || 0) !== 1) {
      const text = memorySearchText(row, rowTags);
      if (!queryTokens.every((token) => text.includes(token))) return false;
    }
    const linkedSymbols = links.symbolsById.get(row.memory_id) || [];
    const linkedFiles = links.filesById.get(row.memory_id) || [];
    const symbolHit = symbols.length > 0 && symbols.some((s) => linkedSymbols.includes(s));
    const fileHit = files.length > 0 && linkedFiles.some((f) => files.includes(f));
    if (anchorMode === "any") {
      // Proactive surfacing: any provided anchor (symbol OR file) qualifies.
      if ((symbols.length > 0 || files.length > 0) && !symbolHit && !fileHit) return false;
    } else {
      if (symbols.length > 0 && !symbolHit) return false;
      if (files.length > 0 && !fileHit) return false;
    }
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

function hydrateMemory(row, links, criteria = {}) {
  const tags = parseJsonArray(row.tags_json);
  const linkedSymbols = links.symbolsById.get(row.memory_id) || [];
  const fileRelPaths = links.filesById.get(row.memory_id) || [];
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
    staleReason: row.stale_reason || null,
    source: row.source || "agent",
    contradictedAt: row.contradicted_at || null,
    contradictionCount: Number(row.contradiction_count || 0),
    ...(Array.isArray(row._missingAnchors) && row._missingAnchors.length > 0
      ? { missingAnchors: row._missingAnchors }
      : {}),
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
  score += recencyScore(row.updated_at, detail.nowMs ?? Date.now());
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

function recencyScore(value, nowMs = Date.now()) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (nowMs - ts) / 86_400_000);
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

// Deterministic method core, exported for parity fixtures and the Rust port
// (posse-encoder-rust atlas_core::memory_rank). Keep these pure.
export {
  tokenize as memoryRankTokenize,
  ftsMatchQuery as memoryFtsMatchQuery,
  recencyScore as memoryRecencyScore,
  memoryScore as memoryRankScore,
  jaccardSimilarity as memoryJaccardSimilarity,
  NEAR_DUPLICATE_JACCARD as MEMORY_NEAR_DUPLICATE_JACCARD,
};

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

/**
 * Deterministic anchor evidence: a memory whose EVERY anchored file has
 * vanished from the indexed tree describes code that no longer exists. Flag
 * it stale ('anchors_missing') and stop surfacing it; partial loss only
 * decorates the surfaced memory with the missing paths. Guards:
 * - needs an open view (ledger-only surfacing skips the check),
 * - only memories created BEFORE the view was built can be flagged — the
 *   surface route is freshness-exempt, so a fresh memory anchored to a file
 *   newer than a stale view must not be punished for the view's lag.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {import("../contracts/api.js").View | null | undefined} view
 * @param {any[]} rows
 * @param {{ filesById: Map<string, string[]> }} links
 */
function applyAnchorEvidence(db, view, rows, links) {
  const viewDb = typeof /** @type {any} */ (view)?._unsafeDb === "function"
    ? /** @type {any} */ (view)._unsafeDb()
    : null;
  if (!viewDb) return rows;
  let viewBuiltAt = "";
  let hasPath;
  try {
    viewBuiltAt = String(/** @type {any} */ (view).meta?.()?.built_at || "");
    const stmt = viewDb.prepare("SELECT 1 AS hit FROM path_to_blob WHERE repo_rel_path = ? LIMIT 1");
    const cache = new Map();
    hasPath = (p) => {
      if (!cache.has(p)) cache.set(p, !!stmt.get(p));
      return cache.get(p);
    };
  } catch {
    return rows; // anchor evidence is advisory; never fail a surface read
  }
  const kept = [];
  for (const row of rows) {
    const files = links.filesById.get(row.memory_id) || [];
    if (files.length === 0) { kept.push(row); continue; }
    let missing;
    try {
      missing = files.filter((f) => !hasPath(f));
    } catch {
      kept.push(row);
      continue;
    }
    if (missing.length === 0) { kept.push(row); continue; }
    const olderThanView = !viewBuiltAt
      || String(row.created_at || "") < viewBuiltAt;
    if (missing.length === files.length && olderThanView) {
      try { flagMemoryStale(db, row.memory_id, "anchors_missing", new Date().toISOString()); } catch { /* advisory */ }
      continue; // every anchor gone: do not surface
    }
    row._missingAnchors = missing;
    kept.push(row);
  }
  return kept;
}

/**
 * Opportunistic staleness sweep: memories untouched for longer than the policy
 * window are flagged stale so proactive surfacing skips them. memory.store
 * resets the flag when a memory is refreshed, and memory.query still returns
 * stale rows (flagged) so they stay discoverable and correctable.
 */
function sweepStaleMemories(db, repoId, policy) {
  const days = clampInt(policy?.memoryStaleAfterDays, 0, 3650, 0);
  if (days <= 0) return;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    db.prepare(
      "UPDATE memories SET stale = 1, stale_reason = 'age' WHERE repo_id = ? AND deleted = 0 AND stale = 0 AND updated_at < ?",
    ).run(repoId, cutoff);
  } catch {
    // Staleness is best-effort; never fail a read because the sweep could not run.
  }
}
