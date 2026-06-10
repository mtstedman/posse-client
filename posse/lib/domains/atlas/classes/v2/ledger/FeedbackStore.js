// @ts-check
//
// ATLAS v2 Ledger — feedback signals store. Owns the `feedback_signals` table:
// recording per-slice useful/missing symbol signals and aggregating recent
// signals (optionally decayed by age / filtered by task-text) for the
// orchestrator's feedback-boost pass. Extracted from the Ledger monolith; the
// Ledger wireframe constructs one and delegates its feedback methods here.

import { runSqliteWrite } from "../../../../../shared/concurrency/functions/sqlite-gate.js";
import { nowIso, parseSymbolIdString } from "../../../functions/v2/ledger/normalize.js";

/** @typedef {import("../../../functions/v2/contracts/api.js").FeedbackRecordInput} FeedbackRecordInput */
/** @typedef {import("../../../functions/v2/contracts/api.js").FeedbackQueryOptions} FeedbackQueryOptions */
/** @typedef {import("../../../functions/v2/contracts/api.js").FeedbackAggregate} FeedbackAggregate */

const MS_PER_DAY = 86_400_000;

/**
 * Group raw feedback rows by symbol identity and weight each row by
 * `exp(-age_days / halfLifeDays)`. Ages are measured against `Date.now()`
 * — using a per-call "now" rather than the most-recent row keeps the
 * weight scale stable across queries that target the same window.
 *
 * @param {Array<{ content_hash: string, local_id: number, signal: string, ts: string }>} rows
 * @param {number} halfLifeDays
 * @returns {FeedbackAggregate[]}
 */
function aggregateWithDecay(rows, halfLifeDays) {
  const now = Date.now();
  /** @type {Map<string, { content_hash: string, local_id: number, useful_count: number, missing_count: number, useful_weight: number, missing_weight: number, last_ts: string }>} */
  const acc = new Map();
  for (const r of rows) {
    const parsedTs = Date.parse(r.ts);
    if (!Number.isFinite(parsedTs)) continue;
    const ageDays = Math.max(0, (now - parsedTs) / MS_PER_DAY);
    const weight = Math.exp(-ageDays / halfLifeDays);
    if (!Number.isFinite(weight)) continue;

    const key = `${r.content_hash}:${r.local_id}`;
    let bucket = acc.get(key);
    if (!bucket) {
      bucket = {
        content_hash: r.content_hash,
        local_id: r.local_id,
        useful_count: 0,
        missing_count: 0,
        useful_weight: 0,
        missing_weight: 0,
        last_ts: r.ts,
      };
      acc.set(key, bucket);
    }
    if (r.signal === "useful") {
      bucket.useful_count += 1;
      bucket.useful_weight += weight;
    } else if (r.signal === "missing") {
      bucket.missing_count += 1;
      bucket.missing_weight += weight;
    }
    if (r.ts > bucket.last_ts) bucket.last_ts = r.ts;
  }
  return Array.from(acc.values());
}

/**
 * Group raw feedback rows by symbol identity without time decay. Used when
 * task-text filtering needs row-level access before aggregation.
 *
 * @param {Array<{ content_hash: string, local_id: number, signal: string, ts: string }>} rows
 * @returns {FeedbackAggregate[]}
 */
function aggregateFeedbackRows(rows) {
  /** @type {Map<string, { content_hash: string, local_id: number, useful_count: number, missing_count: number, last_ts: string }>} */
  const acc = new Map();
  for (const r of rows) {
    const key = `${r.content_hash}:${r.local_id}`;
    let bucket = acc.get(key);
    if (!bucket) {
      bucket = {
        content_hash: r.content_hash,
        local_id: r.local_id,
        useful_count: 0,
        missing_count: 0,
        last_ts: r.ts,
      };
      acc.set(key, bucket);
    }
    if (r.signal === "useful") bucket.useful_count += 1;
    else if (r.signal === "missing") bucket.missing_count += 1;
    if (r.ts > bucket.last_ts) bucket.last_ts = r.ts;
  }
  return Array.from(acc.values());
}

const FEEDBACK_TASK_TEXT_MATCH = 0.34;

/**
 * @param {Array<{ task_text?: string | null }>} rows
 * @param {string | undefined} taskText
 * @param {((detail: { taskText: string, prior_task_text: string | null, score: number | null, included_in_filter: boolean, threshold: number, reason?: string }) => void) | undefined} onMatch
 * @returns {any[]}
 */
function filterFeedbackRowsByTaskText(rows, taskText, onMatch) {
  if (typeof taskText !== "string" || taskText.trim().length === 0) return rows;
  const queryTokens = feedbackTokenSet(taskText);
  if (queryTokens.size === 0) return rows;
  return rows.filter((row) => {
    if (!row.task_text) {
      emitFeedbackTaskTextMatch(onMatch, {
        taskText,
        prior_task_text: null,
        score: null,
        included_in_filter: true,
        threshold: FEEDBACK_TASK_TEXT_MATCH,
        reason: "missing_prior_task_text",
      });
      return true;
    }
    const priorTokens = feedbackTokenSet(row.task_text);
    if (priorTokens.size === 0) {
      emitFeedbackTaskTextMatch(onMatch, {
        taskText,
        prior_task_text: row.task_text,
        score: null,
        included_in_filter: true,
        threshold: FEEDBACK_TASK_TEXT_MATCH,
        reason: "empty_prior_task_tokens",
      });
      return true;
    }
    const overlap = intersectionSize(queryTokens, priorTokens);
    const score = overlap / Math.min(queryTokens.size, priorTokens.size);
    const included = score >= FEEDBACK_TASK_TEXT_MATCH;
    emitFeedbackTaskTextMatch(onMatch, {
      taskText,
      prior_task_text: row.task_text,
      score,
      included_in_filter: included,
      threshold: FEEDBACK_TASK_TEXT_MATCH,
    });
    return included;
  });
}

/**
 * @param {((detail: { taskText: string, prior_task_text: string | null, score: number | null, included_in_filter: boolean, threshold: number, reason?: string }) => void) | undefined} onMatch
 * @param {{ taskText: string, prior_task_text: string | null, score: number | null, included_in_filter: boolean, threshold: number, reason?: string }} detail
 */
function emitFeedbackTaskTextMatch(onMatch, detail) {
  if (typeof onMatch !== "function") return;
  try {
    onMatch(detail);
  } catch {
    // Retrieval should never fail because observability did.
  }
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function feedbackTokenSet(text) {
  const out = new Set();
  const broken = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  for (const piece of broken.split(/[^A-Za-z0-9]+/)) {
    if (!piece) continue;
    const lower = piece.toLowerCase();
    if (lower.length < 2) continue;
    if (FEEDBACK_TASK_STOPWORDS.has(lower)) continue;
    out.add(lower);
  }
  return out;
}

const FEEDBACK_TASK_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "to", "of", "in", "on", "for", "with", "at",
  "by", "from", "as", "this", "that", "it", "its", "we", "us", "our",
  "fix", "add", "remove", "make", "do", "use", "set", "get",
]);

/**
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function intersectionSize(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const t of small) if (large.has(t)) n++;
  return n;
}

export class FeedbackStore {
  /** @type {import("better-sqlite3").Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {Record<string, import("better-sqlite3").Statement>} */
  #stmt;

  /**
   * @param {import("better-sqlite3").Database} db
   * @param {string} dbPath
   */
  constructor(db, dbPath) {
    this.#db = db;
    this.#dbPath = dbPath;
    this.#stmt = {
      feedbackInsert: db.prepare(
        `INSERT INTO feedback_signals
           (ts, slice_handle, content_hash, local_id, signal, task_type, task_text)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ),
      feedbackRecent: db.prepare(
        `SELECT content_hash, local_id,
                SUM(CASE WHEN signal = 'useful'  THEN 1 ELSE 0 END) AS useful_count,
                SUM(CASE WHEN signal = 'missing' THEN 1 ELSE 0 END) AS missing_count,
                MAX(ts) AS last_ts
         FROM feedback_signals
         WHERE ts >= ?
         GROUP BY content_hash, local_id
         LIMIT ?`,
      ),
      feedbackRecentByTaskType: db.prepare(
        `SELECT content_hash, local_id,
                SUM(CASE WHEN signal = 'useful'  THEN 1 ELSE 0 END) AS useful_count,
                SUM(CASE WHEN signal = 'missing' THEN 1 ELSE 0 END) AS missing_count,
                MAX(ts) AS last_ts
         FROM feedback_signals
         WHERE ts >= ? AND task_type = ?
         GROUP BY content_hash, local_id
         LIMIT ?`,
      ),
      // Raw signal fetch — used by the decay path so we can weight rows
      // by age in JS without registering an exp() SQL function.
      feedbackRaw: db.prepare(
        `SELECT content_hash, local_id, signal, ts, task_text
         FROM feedback_signals
         WHERE ts >= ?
         ORDER BY ts DESC
         LIMIT ?`,
      ),
      feedbackRawByTaskType: db.prepare(
        `SELECT content_hash, local_id, signal, ts, task_text
         FROM feedback_signals
         WHERE ts >= ? AND task_type = ?
         ORDER BY ts DESC
         LIMIT ?`,
      ),
    };
  }

  /**
   * Persist a batch of feedback signals for one slice's outcome. Each
   * usefulSymbolIds entry yields one 'useful' row; each missingSymbolIds
   * entry yields one 'missing' row. Malformed IDs are skipped silently —
   * agent.feedback is a best-effort hint, not a contract enforcement point.
   *
   * @param {FeedbackRecordInput} input
   * @returns {number}
   */
  recordFeedback(input) {
    if (!input || typeof input !== "object") return 0;
    const sliceHandle = input.sliceHandle == null ? null : String(input.sliceHandle);
    const taskType = input.taskType == null ? null : String(input.taskType);
    // Cap task_text to keep the ledger small. The boost pass doesn't read
    // task_text — it's stored only for offline analysis.
    const taskText =
      input.taskText == null ? null : String(input.taskText).slice(0, 500);
    const useful = Array.isArray(input.usefulSymbolIds) ? input.usefulSymbolIds : [];
    const missing = Array.isArray(input.missingSymbolIds) ? input.missingSymbolIds : [];
    let inserted = 0;
    const ts = nowIso();
    const txn = this.#db.transaction(() => {
      for (const id of useful) {
        const parsed = parseSymbolIdString(id);
        if (!parsed) continue;
        this.#stmt.feedbackInsert.run(
          ts,
          sliceHandle,
          parsed.content_hash,
          parsed.local_id,
          "useful",
          taskType,
          taskText,
        );
        inserted++;
      }
      for (const id of missing) {
        const parsed = parseSymbolIdString(id);
        if (!parsed) continue;
        this.#stmt.feedbackInsert.run(
          ts,
          sliceHandle,
          parsed.content_hash,
          parsed.local_id,
          "missing",
          taskType,
          taskText,
        );
        inserted++;
      }
    });
    txn();
    return inserted;
  }

  /**
   * @param {FeedbackRecordInput} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<number>}
   */
  recordFeedbackAsync(input, opts = {}) {
    return runSqliteWrite(this.#dbPath, () => this.recordFeedback(input), {
      label: opts.label || "Ledger.recordFeedback",
      waitMs: opts.waitMs,
    });
  }

  /**
   * Aggregate recent feedback rows for the orchestrator's feedback-boost
   * pass. Returns one row per symbol identity with useful/missing counts
   * within the time window.
   *
   * When `halfLifeDays` is set, the result also carries decayed weights
   * (`useful_weight` / `missing_weight`) so the boost pass can favor
   * recent signals over historical ones. Counts are still returned
   * unchanged so telemetry remains comparable across windows.
   *
   * @param {FeedbackQueryOptions} [opts]
   * @returns {FeedbackAggregate[]}
   */
  recentFeedback(opts) {
    const o = opts || {};
    const sinceTs =
      typeof o.sinceTs === "string" && o.sinceTs
        ? o.sinceTs
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const limit =
      typeof o.limit === "number" && o.limit > 0 ? Math.floor(o.limit) : 5000;
    const halfLife = typeof o.halfLifeDays === "number" && o.halfLifeDays > 0 ? o.halfLifeDays : null;

    const hasTaskText = typeof o.taskText === "string" && o.taskText.trim().length > 0;
    if (halfLife != null || hasTaskText) {
      /** @type {any[]} */
      const raw = o.taskType
        ? this.#stmt.feedbackRawByTaskType.all(sinceTs, o.taskType, limit)
        : this.#stmt.feedbackRaw.all(sinceTs, limit);
      const filtered = filterFeedbackRowsByTaskText(raw, o.taskText, /** @type {any} */ (o).onTaskTextMatch);
      return halfLife != null
        ? aggregateWithDecay(filtered, halfLife)
        : aggregateFeedbackRows(filtered);
    }

    /** @type {any[]} */
    let rows;
    if (o.taskType) {
      rows = this.#stmt.feedbackRecentByTaskType.all(sinceTs, o.taskType, limit);
    } else {
      rows = this.#stmt.feedbackRecent.all(sinceTs, limit);
    }
    return rows.map((r) => ({
      content_hash: r.content_hash,
      local_id: r.local_id,
      useful_count: Number(r.useful_count) || 0,
      missing_count: Number(r.missing_count) || 0,
      last_ts: r.last_ts,
    }));
  }
}
