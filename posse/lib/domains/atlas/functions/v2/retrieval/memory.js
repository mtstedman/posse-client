// @ts-check
//
// Native ATLAS v2 memory handlers. These replace the original ATLAS-MCP memory
// graph with a durable ATLAS memory store while keeping public action names stable.

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";
import { okEnvelope, errorEnvelope } from "./envelope.js";
import { sha256Hex } from "../hash.js";
import { normalizeRepoPath } from "../paths.js";
import { parseAtlasSymbolId, sanitizeAtlasSymbolIdList } from "../symbol-id.js";
import { memoryDbPathForLedgerDb } from "../runtime-paths.js";
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

const MEMORY_SCHEMA_VERSION = 1;

const MEMORY_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO memory_meta(key, value)
VALUES ('schema_version', '${MEMORY_SCHEMA_VERSION}')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

CREATE TABLE IF NOT EXISTS memories (
  memory_id       TEXT PRIMARY KEY,
  repo_id         TEXT,
  type            TEXT NOT NULL CHECK (type IN (
                    'decision','bugfix','task_context','pattern',
                    'convention','architecture','performance','security'
                  )),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  tags_json       TEXT NOT NULL DEFAULT '[]',
  confidence      REAL NOT NULL DEFAULT 0.5,
  content_hash    TEXT NOT NULL,
  stale           INTEGER NOT NULL DEFAULT 0,
  stale_reason    TEXT,
  wrong_at        TEXT,
  wrong_count     INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT,
  source          TEXT NOT NULL DEFAULT 'agent'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash_active
  ON memories(repo_id, content_hash)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_memories_repo_type_updated
  ON memories(repo_id, type, updated_at DESC)
  WHERE deleted = 0;

CREATE INDEX IF NOT EXISTS idx_memories_updated
  ON memories(updated_at DESC)
  WHERE deleted = 0;

CREATE TABLE IF NOT EXISTS memory_symbol_links (
  memory_id       TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  local_id        INTEGER NOT NULL,
  PRIMARY KEY(memory_id, content_hash, local_id),
  FOREIGN KEY(memory_id) REFERENCES memories(memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_symbol_links_symbol
  ON memory_symbol_links(content_hash, local_id);

CREATE TABLE IF NOT EXISTS memory_file_links (
  memory_id       TEXT NOT NULL,
  repo_rel_path   TEXT NOT NULL,
  PRIMARY KEY(memory_id, repo_rel_path),
  FOREIGN KEY(memory_id) REFERENCES memories(memory_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_file_links_path
  ON memory_file_links(repo_rel_path);
`;

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryStoreParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memoryStore({ versionId, params, ledger, repoId }) {
  const opened = openMemoryActionDb({ ledger, action: "memory.store", versionId });
  if (opened.error) return opened.error;
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  const policy = getEffectivePolicy(ledger, effectiveRepo(repoId, params.repoId));
  if (!policy.memoryEnabled) {
    return finish(memoryDisabled("memory.store", versionId));
  }

  const type = normalizeMemoryType(params.type) || "task_context";
  const title = cleanString(params.title, 120);
  const content = cleanString(params.content, 1200);
  if (!title || !content) {
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_memory",
      message: "memory.store requires non-empty title and content",
    }));
  }

  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const tags = [];
  let symbolIds;
  try {
    symbolIds = sanitizeAtlasSymbolIdList(params.symbolIds || [], 100, "memory.store symbolIds");
  } catch (err) {
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "invalid_symbol_id",
      message: err?.message || String(err),
    }));
  }
  const fileRelPaths = normalizePaths(params.fileRelPaths || []);
  const confidence = 1;
  const providedId = cleanMemoryId(params.memoryId);
  const contentHash = memoryContentHash({ type, title, content, tags, symbolIds, fileRelPaths });
  const memoryId = providedId || `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const existing = providedId ? findMemoryById(db, memoryId) : null;
  if (existing && existing.repo_id !== effectiveRepoId) {
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "memory_id_conflict",
      message: `Memory ${memoryId} already belongs to a different repository`,
    }));
  }
  const sameIdSameContent = !!(existing && existing.content_hash === contentHash);
  const existingByHash = sameIdSameContent ? null : findActiveMemoryByHash(db, effectiveRepoId, contentHash);
  const duplicateToReplace = existing && existingByHash && existingByHash.memory_id !== memoryId
    ? existingByHash.memory_id
    : null;
  if (existingByHash && existingByHash.memory_id !== memoryId) {
    if (providedId && !existing) {
      return finish(errorEnvelope({
        action: "memory.store",
        versionId,
        code: "duplicate_memory_content",
        message: `Memory content already exists as ${existingByHash.memory_id}`,
      }));
    }
    if (!providedId) {
      reviveMemory(db, existingByHash.memory_id, new Date().toISOString());
      return finish(okEnvelope({
        action: "memory.store",
        versionId,
        data: {
          ok: true,
          memoryId: existingByHash.memory_id,
          memory_id: existingByHash.memory_id,
          created: false,
          deduplicated: true,
        },
      }));
    }
  }

  // Exact-hash dedupe misses rewordings of the same knowledge. For
  // auto-generated ids (agent "just remember this" writes) a conservative
  // near-duplicate check folds the write into the existing memory instead of
  // accumulating parallel variants. Explicit ids are intentional updates and
  // are never redirected.
  if (!providedId && !existing) {
    const nearDuplicate = findNearDuplicateMemory(db, effectiveRepoId, type, title, content);
    if (nearDuplicate) {
      reviveMemory(db, nearDuplicate.memory_id, new Date().toISOString());
      return finish(okEnvelope({
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
      }));
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
          wrong_at = NULL,
          wrong_count = 0,
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
    return finish(errorEnvelope({
      action: "memory.store",
      versionId,
      code: "memory_store_failed",
      message: err?.message || String(err),
    }));
  }
  sweepStaleMemories(db, effectiveRepoId, policy);
  enforceMemoryCap(db, effectiveRepoId, policy, now);
  getRetrievalCache().invalidateAll();

  return finish(okEnvelope({
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
  }));
}

const MEMORY_FLAG_REASONS = new Set(["wrong", "anchors_missing", "manual", "duplicate"]);

/**
 * Evidence-based staleness: flag a memory stale WITH a reason instead of
 * deleting it. 'wrong' (assessment/work proved it wrong) also stamps
 * wrong_at and bumps wrong_count. Flagged memories stop
 * surfacing proactively but stay correctable — suppression
 * stays a deliberate GC decision.
 *
 * @param {{
 *   versionId: string,
 *   params: { repoId?: string, memoryId: string, reason: string, detail?: string },
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
function memoryFlagInternal({ versionId, params, ledger, repoId }) {
  const opened = openMemoryActionDb({ ledger, action: "memory.feedback", versionId });
  if (opened.error) return opened.error;
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  if (!getEffectivePolicy(ledger, effectiveRepoId).memoryEnabled) {
    return finish(memoryDisabled("memory.feedback", versionId));
  }
  const memoryId = cleanMemoryId(params.memoryId);
  if (!memoryId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "invalid_memory_id",
      message: "memory.feedback requires memoryId",
    }));
  }
  const reason = String(params.reason || "").trim().toLowerCase();
  if (!MEMORY_FLAG_REASONS.has(reason)) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "invalid_flag_reason",
      message: `memory.feedback stale reason must be one of: ${[...MEMORY_FLAG_REASONS].join(", ")}`,
    }));
  }
  const row = findMemoryById(db, memoryId);
  if (!row || Number(row.deleted || 0) === 1 || row.repo_id !== effectiveRepoId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "memory_not_found",
      message: `Memory ${memoryId} was not found`,
    }));
  }
  const now = new Date().toISOString();
  flagMemoryStale(db, memoryId, reason, now);
  getRetrievalCache().invalidateAll();
  const updated = findMemoryById(db, memoryId);
  return finish(okEnvelope({
    action: "memory.feedback",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      stale: true,
      staleReason: reason,
      wrongCount: Number(updated?.wrong_count || 0),
      detail: cleanString(params.detail, 500) || undefined,
    },
  }));
}

const MEMORY_FEEDBACK_VERDICTS = new Set(["used", "stale", "wrong", "duplicate"]);

/**
 * First-pass memory feedback surface. Negative freshness verdicts suppress the
 * memory until it is refreshed; positive feedback resets the recency head.
 *
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryFeedbackParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 * }} args
 */
export function memoryFeedback({ versionId, params, ledger, repoId }) {
  const verdict = String(params.verdict || "").trim().toLowerCase();
  if (!MEMORY_FEEDBACK_VERDICTS.has(verdict)) {
    return errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "invalid_memory_feedback_verdict",
      message: "memory.feedback verdict must be one of: used, stale, wrong, duplicate",
    });
  }
  if (verdict === "stale" || verdict === "wrong" || verdict === "duplicate") {
    const flagged = memoryFlagInternal({
      versionId,
      params: {
        repoId: params.repoId,
        memoryId: params.memoryId,
        reason: verdict === "wrong" ? "wrong" : verdict === "duplicate" ? "duplicate" : "manual",
        detail: params.detail,
      },
      ledger,
      repoId,
    });
    if (!flagged?.ok) return flagged;
    return okEnvelope({
      action: "memory.feedback",
      versionId,
      data: {
        ok: true,
        memoryId: flagged.data.memoryId,
        memory_id: flagged.data.memory_id,
        verdict,
        stale: true,
        staleReason: flagged.data.staleReason,
        wrongCount: flagged.data.wrongCount,
        ...(params.detail ? { detail: cleanString(params.detail, 500) } : {}),
      },
    });
  }

  const opened = openMemoryActionDb({ ledger, action: "memory.feedback", versionId });
  if (opened.error) return opened.error;
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  if (!getEffectivePolicy(ledger, effectiveRepoId).memoryEnabled) {
    return finish(memoryDisabled("memory.feedback", versionId));
  }
  const memoryId = cleanMemoryId(params.memoryId);
  const row = memoryId ? findMemoryById(db, memoryId) : null;
  if (!row || Number(row.deleted || 0) === 1 || row.repo_id !== effectiveRepoId) {
    return finish(errorEnvelope({
      action: "memory.feedback",
      versionId,
      code: "memory_not_found",
      message: `Memory ${memoryId || "(missing)"} was not found`,
    }));
  }
  const now = new Date().toISOString();
  if (verdict === "used") {
    db.prepare(
      `UPDATE memories
       SET stale = 0,
           stale_reason = NULL,
           wrong_at = NULL,
           updated_at = ?
       WHERE memory_id = ?`,
    ).run(now, memoryId);
    getRetrievalCache().invalidateAll();
  }
  return finish(okEnvelope({
    action: "memory.feedback",
    versionId,
    data: {
      ok: true,
      memoryId,
      memory_id: memoryId,
      verdict,
      recorded: verdict === "used",
      ...(params.detail ? { detail: cleanString(params.detail, 500) } : {}),
    },
  }));
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
  if (reason === "wrong") {
    db.prepare(
      `UPDATE memories
       SET stale = 1, stale_reason = ?, wrong_at = ?,
           wrong_count = wrong_count + 1
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
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const policy = getEffectivePolicy(ledger, effectiveRepoId);
  if (!policy.memoryEnabled) {
    return memoryDisabled("memory.surface", versionId);
  }
  const requested = {
    symbolIds: safeSymbolIds(params.symbolIds || [], "memory.surface symbolIds"),
    fileRelPaths: normalizePaths(params.fileRelPaths || []),
  };
  if (requested.symbolIds.length === 0 && requested.fileRelPaths.length === 0) {
    return okEnvelope({
      action: "memory.surface",
      versionId,
      data: { symbols: [], files: [] },
    });
  }
  const opened = openMemoryReadDb({ ledger, action: "memory.surface", versionId });
  if (opened.error) return opened.error;
  if (opened.missing) {
    return okEnvelope({ action: "memory.surface", versionId, data: { symbols: [], files: [] } });
  }
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  try {
    const rows = candidateRows(db, effectiveRepoId, { includeDeleted: false });
    const links = fetchMemoryLinks(db, rows.map((row) => row.memory_id));
    let filtered = filterRows(rows, params, links, { anchorMode: "any", excludeStale: true, policy });
    filtered = applyAnchorEvidence(view, filtered, links);
    const presence = memoryAnchorPresence(filtered, links, requested);
    return finish(okEnvelope({
      action: "memory.surface",
      versionId,
      data: presence,
    }));
  } catch (err) {
    return finish(errorEnvelope({
      action: "memory.surface",
      versionId,
      code: "memory_surface_failed",
      message: err?.message || String(err),
    }));
  }
}

/**
 * @param {{
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").MemoryGetParams,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string | null,
 *   view?: import("../contracts/api.js").View | null,
 * }} args
 */
export function memoryGet({ versionId, params, ledger, repoId, view = null }) {
  const effectiveRepoId = effectiveRepo(repoId, params.repoId);
  const policy = getEffectivePolicy(ledger, effectiveRepoId);
  if (!policy.memoryEnabled) {
    return memoryDisabled("memory.get", versionId);
  }
  const requested = {
    symbolIds: safeSymbolIds(params.symbolIds || [], "memory.get symbolIds"),
    fileRelPaths: normalizePaths(params.fileRelPaths || []),
  };
  if (requested.symbolIds.length === 0 && requested.fileRelPaths.length === 0) {
    return okEnvelope({
      action: "memory.get",
      versionId,
      data: { symbols: {}, files: {} },
    });
  }
  const opened = openMemoryReadDb({ ledger, action: "memory.get", versionId });
  if (opened.error) return opened.error;
  if (opened.missing) {
    return okEnvelope({ action: "memory.get", versionId, data: { symbols: {}, files: {} } });
  }
  const db = opened.db;
  const finish = (result) => {
    closeMemoryDb(db);
    return result;
  };
  try {
    const rows = candidateRows(db, effectiveRepoId, { includeDeleted: false });
    const links = fetchMemoryLinks(db, rows.map((row) => row.memory_id));
    let filtered = filterRows(rows, params, links, { anchorMode: "any", excludeStale: true, policy });
    filtered = applyAnchorEvidence(view, filtered, links);
    return finish(okEnvelope({
      action: "memory.get",
      versionId,
      data: memoryContentByAnchor(filtered, links, requested),
    }));
  } catch (err) {
    return finish(errorEnvelope({
      action: "memory.get",
      versionId,
      code: "memory_get_failed",
      message: err?.message || String(err),
    }));
  }
}

function ledgerDbPathFromHandle(ledger) {
  return typeof /** @type {any} */ (ledger)?._dbPath === "function"
    ? /** @type {any} */ (ledger)._dbPath()
    : "";
}

function memoryDbPathForLedger(ledger) {
  const ledgerPath = ledgerDbPathFromHandle(ledger);
  return memoryDbPathForLedgerDb(ledgerPath);
}

function openMemoryDbForLedger(ledger) {
  const dbPath = memoryDbPathForLedger(ledger);
  if (!dbPath) return null;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.exec(MEMORY_DDL);
  upgradeMemorySchema(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function openMemoryReadDbForLedger(ledger) {
  const dbPath = memoryDbPathForLedger(ledger);
  if (!dbPath) return { db: null, missing: false };
  if (!fs.existsSync(dbPath)) return { db: null, missing: true };
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    return { db, missing: false };
  } catch {
    return { db: null, missing: true };
  }
}

function closeMemoryDb(db) {
  try { db?.close?.(); } catch { /* ignore */ }
}

function openMemoryActionDb({ ledger, action, versionId }) {
  const db = openMemoryDbForLedger(ledger);
  if (!db) {
    return {
      error: errorEnvelope({
        action: /** @type {any} */ (action),
        versionId,
        code: "memory_store_unavailable",
        message: "ATLAS memory requires an ATLAS repository context",
      }),
      db: null,
    };
  }
  return { db, error: null };
}

function openMemoryReadDb({ ledger, action, versionId }) {
  const opened = openMemoryReadDbForLedger(ledger);
  if (opened.db || opened.missing) return { db: opened.db, missing: opened.missing, error: null };
  return {
    db: null,
    missing: false,
    error: errorEnvelope({
      action: /** @type {any} */ (action),
      versionId,
      code: "memory_store_unavailable",
      message: "ATLAS memory requires an ATLAS repository context",
    }),
  };
}

function upgradeMemorySchema(db) {
  const columns = new Set(
    db.prepare("PRAGMA table_info(memories)").all().map((row) => String(row.name || "")),
  );
  if (!columns.has("wrong_at")) {
    db.prepare("ALTER TABLE memories ADD COLUMN wrong_at TEXT").run();
  }
  if (!columns.has("wrong_count")) {
    db.prepare("ALTER TABLE memories ADD COLUMN wrong_count INTEGER NOT NULL DEFAULT 0").run();
  }
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

function reviveMemory(db, memoryId, now) {
  db.prepare(
    `UPDATE memories
     SET stale = 0,
         stale_reason = NULL,
         wrong_at = NULL,
         wrong_count = 0,
         updated_at = ?
     WHERE memory_id = ?`,
  ).run(now, memoryId);
  getRetrievalCache().invalidateAll();
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

function candidateRows(db, repoId, { includeDeleted = false } = {}) {
  const deletedSql = includeDeleted ? "" : "AND deleted = 0";
  return db.prepare(
    `SELECT * FROM memories
     WHERE repo_id = ? ${deletedSql}
     ORDER BY updated_at DESC
     LIMIT 5000`,
  ).all(repoId);
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

function filterRows(rows, params = {}, links, { anchorMode = "all", excludeStale = false, policy = null } = {}) {
  const symbols = safeSymbolIds(params.symbolIds || []);
  const files = normalizePaths(params.fileRelPaths || []);
  return rows.filter((row) => {
    if (excludeStale && memoryIsStaleForRead(row, policy)) return false;
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

function memoryIsStaleForRead(row, policy) {
  if (Number(row.stale || 0) === 1) return true;
  const days = clampInt(policy?.memoryStaleAfterDays, 0, 3650, 0);
  if (days <= 0) return false;
  const updatedAt = Date.parse(String(row.updated_at || ""));
  if (!Number.isFinite(updatedAt)) return false;
  return updatedAt < Date.now() - days * 86_400_000;
}

function safeSymbolIds(values, label = "memory symbolIds") {
  try {
    return sanitizeAtlasSymbolIdList(values, 500, label);
  } catch {
    return [];
  }
}

function memoryAnchorPresence(rows, links, params = {}) {
  const requestedSymbols = safeSymbolIds(params.symbolIds || [], "memory.surface symbolIds");
  const requestedFiles = normalizePaths(params.fileRelPaths || []);
  const symbols = new Set();
  const files = new Set();
  for (const row of rows) {
    const linkedSymbols = links.symbolsById.get(row.memory_id) || [];
    const linkedFiles = activeMemoryFileLinks(row, links);
    for (const symbolId of requestedSymbols) {
      if (linkedSymbols.includes(symbolId)) symbols.add(symbolId);
    }
    for (const fileRelPath of requestedFiles) {
      if (linkedFiles.includes(fileRelPath)) files.add(fileRelPath);
    }
  }
  return {
    symbols: requestedSymbols.filter((symbolId) => symbols.has(symbolId)),
    files: requestedFiles.filter((fileRelPath) => files.has(fileRelPath)),
  };
}

function memoryContentByAnchor(rows, links, params = {}) {
  const requestedSymbols = safeSymbolIds(params.symbolIds || [], "memory.get symbolIds");
  const requestedFiles = normalizePaths(params.fileRelPaths || []);
  const symbols = Object.fromEntries(requestedSymbols.map((symbolId) => [symbolId, []]));
  const files = Object.fromEntries(requestedFiles.map((fileRelPath) => [fileRelPath, []]));
  const sorted = [...rows].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  for (const row of sorted) {
    const linkedSymbols = links.symbolsById.get(row.memory_id) || [];
    const linkedFiles = activeMemoryFileLinks(row, links);
    const memory = memoryForAnchorGet(row, links);
    for (const symbolId of requestedSymbols) {
      if (linkedSymbols.includes(symbolId)) symbols[symbolId].push(memory);
    }
    for (const fileRelPath of requestedFiles) {
      if (linkedFiles.includes(fileRelPath)) files[fileRelPath].push(memory);
    }
  }
  for (const key of Object.keys(symbols)) {
    if (symbols[key].length === 0) delete symbols[key];
  }
  for (const key of Object.keys(files)) {
    if (files[key].length === 0) delete files[key];
  }
  return { symbols, files };
}

function memoryForAnchorGet(row, links) {
  return {
    memoryId: row.memory_id,
    memory_id: row.memory_id,
    title: row.title,
    content: row.content,
    source: row.source || "agent",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    symbolIds: links.symbolsById.get(row.memory_id) || [],
    fileRelPaths: activeMemoryFileLinks(row, links),
    ...(missingMemoryFileAnchors(row).length > 0
      ? { missingAnchors: missingMemoryFileAnchors(row) }
      : {}),
  };
}

function missingMemoryFileAnchors(row) {
  return Array.isArray(row?._missingAnchors)
    ? row._missingAnchors.map(String).filter(Boolean)
    : [];
}

function activeMemoryFileLinks(row, links) {
  const linkedFiles = links.filesById.get(row.memory_id) || [];
  const missing = new Set(missingMemoryFileAnchors(row));
  if (missing.size === 0) return linkedFiles;
  return linkedFiles.filter((fileRelPath) => !missing.has(fileRelPath));
}

function memoryScore(row, detail) {
  const matchedSymbols = Array.isArray(detail?.matchedSymbols) ? detail.matchedSymbols : [];
  const matchedFiles = Array.isArray(detail?.matchedFiles) ? detail.matchedFiles : [];
  let score = 0;
  score += Number(row.confidence || 0) || 0;
  score += recencyScore(row.updated_at, detail?.nowMs ?? Date.now());
  score += matchedSymbols.length * 2;
  score += matchedFiles.length;
  if (detail?.taskType && row.type === detail.taskType) score += 0.75;
  const query = cleanString(detail?.query, 1000).toLowerCase();
  if (query) {
    const text = memorySearchText(row, Array.isArray(detail?.tags) ? detail.tags : []);
    for (const token of tokenize(query)) {
      if (text.includes(token)) score += 0.5;
    }
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

// Deterministic method core, exported for parity fixtures and the Rust port
// (posse-encoder-rust atlas_core::memory_rank). Keep these pure.
export {
  tokenize as memoryRankTokenize,
  recencyScore as memoryRecencyScore,
  memoryScore as memoryRankScore,
  jaccardSimilarity as memoryJaccardSimilarity,
  NEAR_DUPLICATE_JACCARD as MEMORY_NEAR_DUPLICATE_JACCARD,
};

/**
 * Deterministic anchor evidence: a memory whose EVERY anchored file has
 * vanished from the indexed tree describes code that no longer exists, so
 * read paths skip it without mutating memory.db. Partial loss only decorates
 * the surfaced memory with the missing paths. Guards:
 * - needs an open view (ledger-only surfacing skips the check),
 * - only memories created BEFORE the view was built can be flagged — the
 *   surface route is freshness-exempt, so a fresh memory anchored to a file
 *   newer than a stale view must not be punished for the view's lag.
 *
 * @param {import("../contracts/api.js").View | null | undefined} view
 * @param {any[]} rows
 * @param {{ filesById: Map<string, string[]> }} links
 */
function applyAnchorEvidence(view, rows, links) {
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
 * resets the flag when a memory is refreshed.
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
