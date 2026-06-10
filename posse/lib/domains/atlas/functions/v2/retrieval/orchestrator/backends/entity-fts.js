// @ts-check
//
// Ledger-backed entity FTS for opt-in multi-entity symbol.search calls.

/** @typedef {import("../../../contracts/api.js").Ledger} Ledger */
/** @typedef {import("../../../contracts/tool-results.js").EntitySearchHit} EntitySearchHit */

const ENTITY_TYPES = new Set(["memories", "feedback"]);

/**
 * @param {{
 *   ledger?: Ledger,
 *   query: string,
 *   repoId?: string | null,
 *   entities?: string[],
 *   limit: number,
 * }} args
 * @returns {EntitySearchHit[]}
 */
export function runEntityFtsBackends({ ledger, query, repoId = null, entities = [], limit }) {
  const requested = new Set((entities || []).map((entity) => String(entity || "").trim()).filter(Boolean));
  if (![...requested].some((entity) => ENTITY_TYPES.has(entity))) return [];
  const db = ledger && typeof /** @type {any} */ (ledger)._unsafeDb === "function"
    ? /** @type {any} */ (ledger)._unsafeDb()
    : null;
  if (!db) return [];
  const match = ftsMatchQuery(query);
  if (!match) return [];
  const cap = Math.max(1, Math.min(100, limit || 25));
  /** @type {EntitySearchHit[]} */
  const hits = [];
  if (requested.has("memories")) hits.push(...searchMemories({ db, match, repoId, limit: cap }));
  if (requested.has("feedback")) hits.push(...searchFeedback({ db, match, limit: cap }));
  return hits
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.title.localeCompare(b.title))
    .slice(0, cap);
}

/**
 * @param {{ db: any, match: string, repoId?: string | null, limit: number }} args
 * @returns {EntitySearchHit[]}
 */
function searchMemories({ db, match, repoId, limit }) {
  if (!tableExists(db, "memories_fts")) return [];
  if (!repoId) return [];
  const repoWhere = repoId ? "AND m.repo_id = ?" : "";
  const sql = `
    SELECT m.*, bm25(memories_fts, 4.0, 3.0, 1.0) AS _fts_rank
    FROM memories_fts
    JOIN memories m ON m.rowid = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.deleted = 0
      ${repoWhere}
    ORDER BY _fts_rank ASC, m.updated_at DESC
    LIMIT ?`;
  const params = repoId ? [match, repoId, limit] : [match, limit];
  try {
    const rows = /** @type {any[]} */ (db.prepare(sql).all(...params));
    return rows.map((row) => ({
      entity: "memory",
      id: String(row.memory_id),
      title: String(row.title || row.memory_id),
      snippet: snippet(row.content),
      score: bm25Score(row._fts_rank),
      ref: {
        memoryId: row.memory_id,
        repoId: row.repo_id,
        type: row.type,
        tags: parseJsonArray(row.tags_json),
        updatedAt: row.updated_at,
      },
    }));
  } catch (err) {
    warnEntityFtsFailure("memories", err);
    return [];
  }
}

/**
 * @param {{ db: any, match: string, limit: number }} args
 * @returns {EntitySearchHit[]}
 */
function searchFeedback({ db, match, limit }) {
  if (!tableExists(db, "feedback_fts")) return [];
  try {
    const rows = /** @type {any[]} */ (db.prepare(
      `SELECT f.*, bm25(feedback_fts, 3.0, 2.0, 1.0) AS _fts_rank
       FROM feedback_fts
       JOIN feedback_signals f ON f.id = feedback_fts.rowid
       WHERE feedback_fts MATCH ?
       ORDER BY _fts_rank ASC, f.ts DESC
       LIMIT ?`,
    ).all(match, limit));
    return rows.map((row) => ({
      entity: "feedback",
      id: `feedback:${row.id}`,
      title: `${row.signal || "feedback"}${row.task_type ? ` ${row.task_type}` : ""}`,
      snippet: snippet(row.task_text),
      score: bm25Score(row._fts_rank),
      ref: {
        feedbackId: row.id,
        symbolId: `${row.content_hash}:${row.local_id}`,
        signal: row.signal,
        taskType: row.task_type,
        ts: row.ts,
      },
    }));
  } catch (err) {
    warnEntityFtsFailure("feedback", err);
    return [];
  }
}

function bm25Score(rank) {
  const numeric = Number(rank);
  if (!Number.isFinite(numeric)) return 0;
  return -numeric;
}

function warnEntityFtsFailure(entity, err) {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[atlas-v2 entity-fts] ${entity} search failed: ${message}`);
}

function snippet(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function ftsMatchQuery(text) {
  const tokens = String(text || "").toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2).slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `${token}*`).join(" OR ");
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function tableExists(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  } catch {
    return false;
  }
}
