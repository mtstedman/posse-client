import { getDb } from "../../../shared/storage/functions/index.js";

const CANNED_ACTION_DENYLIST = [
  /use the prior failure\/success path as a caution note/i,
  /respect the current file scope contract/i,
  /treat this as a scope-sensitive area/i,
  /do not keep retrying the same implementation path after identical failures/i,
  /before editing beyond declared scope/i,
  /before finishing changes touching these files/i,
  /verify the expected dependency, config, or generated file exists/i,
  /investigate the repeated structural blocker/i,
  /reuse only the concrete part of this prior path/i,
  /when working in this scope, verify the concrete condition/i,
  /avoid repeating the failed path/i,
  /reuse the successful approach recorded/i,
];

function normalizeJsonArrayText(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(Array.isArray(parsed) ? parsed : [parsed]);
    } catch {
      return JSON.stringify([value]);
    }
  }
  return JSON.stringify([value]);
}

function parseJsonArrayText(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [value];
  }
}

function normalizePathsForCompare(value) {
  return parseJsonArrayText(normalizeJsonArrayText(value))
    .map((item) => String(item || "").replace(/\\/g, "/").trim())
    .filter(Boolean)
    .sort();
}

function normalizeTextForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/["'`]/g, "")
    .trim()
    .slice(0, 320);
}

export function isCannedInsightAction(action) {
  const text = String(action || "");
  return CANNED_ACTION_DENYLIST.some((regex) => regex.test(text));
}

function defaultExpiresAt({ insight_type = null, confidence = null, source = null } = {}) {
  if (insight_type === "human_override" || source === "human") return null;
  const bucket = String(confidence || "low").toLowerCase();
  const days = bucket === "high" ? 60 : bucket === "medium" ? 30 : 14;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isDuplicateInsight(db, {
  insight_type,
  summary,
  action,
  detail,
  file_paths,
  lookbackHours = 24,
} = {}) {
  const compareText = normalizeTextForCompare(action || summary || detail);
  if (!compareText) return false;
  const comparePaths = normalizePathsForCompare(file_paths).join("\n");
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT insight_type, summary, detail, action, file_paths
    FROM run_insights
    WHERE insight_type = ?
      AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT 80
  `).all(insight_type, cutoff);
  return rows.some((row) => {
    const rowText = normalizeTextForCompare(row.action || row.summary || row.detail);
    if (rowText !== compareText) return false;
    const rowPaths = normalizePathsForCompare(row.file_paths).join("\n");
    return rowPaths === comparePaths;
  });
}

/**
 * Store a run insight extracted from a completed work item or job.
 * @param {{ work_item_id?: number, job_id?: number, insight_type: string, summary: string, detail?: string, file_paths?: string[], insight_kind?: string, action?: string, confidence?: string, source?: string, evidence?: string[]|string, expires_at?: string, memory_type?: string, promotion_status?: string, promotion_reason?: string, promoted_memory_id?: string, rejection_reason?: string, allow_canned?: boolean, dedupe?: boolean }} opts
 * @returns {number|null} inserted row id, or null when noise/dedup filters suppress the row
 */
export function storeInsight({
  work_item_id = null,
  job_id = null,
  insight_type,
  summary,
  detail = null,
  file_paths = null,
  insight_kind = null,
  action = null,
  confidence = null,
  source = null,
  evidence = null,
  expires_at = null,
  memory_type = null,
  promotion_status = null,
  promotion_reason = null,
  promoted_memory_id = null,
  rejection_reason = null,
  allow_canned = false,
  dedupe = true,
}) {
  const db = getDb();
  if (!allow_canned && isCannedInsightAction(action)) return null;
  if (dedupe && isDuplicateInsight(db, { insight_type, summary, action, detail, file_paths })) return null;
  const evidenceJson = normalizeJsonArrayText(evidence);
  const resolvedExpiresAt = expires_at ?? defaultExpiresAt({ insight_type, confidence, source });
  const resolvedPromotionStatus = promotion_status || "pending";
  return db.prepare(`
    INSERT INTO run_insights (
      work_item_id, job_id, insight_type, summary, detail,
      insight_kind, action, confidence, source, evidence, expires_at,
      memory_type, promotion_status, promotion_reason, promoted_memory_id, rejection_reason,
      file_paths
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    work_item_id, job_id, insight_type, summary, detail,
    insight_kind, action, confidence, source, evidenceJson, resolvedExpiresAt,
    memory_type, resolvedPromotionStatus, promotion_reason, promoted_memory_id, rejection_reason,
    normalizeJsonArrayText(file_paths)
  ).lastInsertRowid;
}

export function updateInsightPromotion(id, {
  promotion_status = null,
  promotion_reason = null,
  promoted_memory_id = null,
  rejection_reason = null,
  memory_type = null,
} = {}) {
  const db = getDb();
  const current = db.prepare(`SELECT * FROM run_insights WHERE id = ?`).get(id);
  if (!current) return false;
  db.prepare(`
    UPDATE run_insights
    SET promotion_status = ?,
        promotion_reason = ?,
        promoted_memory_id = ?,
        rejection_reason = ?,
        memory_type = ?
    WHERE id = ?
  `).run(
    promotion_status ?? current.promotion_status,
    promotion_reason ?? current.promotion_reason,
    promoted_memory_id ?? current.promoted_memory_id,
    rejection_reason ?? current.rejection_reason,
    memory_type ?? current.memory_type,
    id,
  );
  return true;
}

export function claimInsightPromotion(id, {
  promotion_reason = null,
  memory_type = null,
} = {}) {
  if (id == null) return false;
  const db = getDb();
  const result = db.prepare(`
    UPDATE run_insights
    SET promotion_status = 'pending',
        promotion_reason = ?,
        memory_type = ?,
        promoted_memory_id = NULL,
        rejection_reason = NULL
    WHERE id = ?
      AND (
        promotion_status IS NULL
        OR trim(promotion_status) = ''
        OR promotion_status = 'pending'
      )
      AND (promotion_reason IS NULL OR trim(promotion_reason) = '')
      AND (memory_type IS NULL OR trim(memory_type) = '')
      AND (promoted_memory_id IS NULL OR trim(promoted_memory_id) = '')
      AND (rejection_reason IS NULL OR trim(rejection_reason) = '')
  `).run(
    promotion_reason,
    memory_type,
    id,
  );
  return result.changes === 1;
}

/**
 * Retrieve recent insights, optionally filtered by type or file scope.
 * @param {{ limit?: number, insight_type?: string, file_paths?: string[], only_actionable?: boolean }} opts
 */
export function getInsights({ limit = 20, insight_type = null, file_paths = null, only_actionable = false } = {}) {
  const db = getDb();
  const actionClause = only_actionable ? ` AND action IS NOT NULL AND trim(action) != ''` : "";
  const notExpiredClause = ` AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

  if (insight_type && file_paths && file_paths.length > 0) {
    // Filter by type AND at least one matching file path
    const rows = db.prepare(`
      SELECT * FROM run_insights WHERE insight_type = ?${actionClause}${notExpiredClause}
      ORDER BY created_at DESC LIMIT ?
    `).all(insight_type, limit * 3);
    return _filterByFilePaths(rows, file_paths).slice(0, limit);
  }

  if (insight_type) {
    return db.prepare(`
      SELECT * FROM run_insights WHERE insight_type = ?${actionClause}${notExpiredClause}
      ORDER BY created_at DESC LIMIT ?
    `).all(insight_type, limit);
  }

  if (file_paths && file_paths.length > 0) {
    const rows = db.prepare(`
      SELECT * FROM run_insights
      WHERE 1=1${actionClause}${notExpiredClause}
      ORDER BY created_at DESC LIMIT ?
    `).all(limit * 3);
    return _filterByFilePaths(rows, file_paths).slice(0, limit);
  }

  return db.prepare(`
    SELECT * FROM run_insights
    WHERE 1=1${actionClause}${notExpiredClause}
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

/**
 * Get insights for a specific work item.
 */
export function getInsightsByWorkItem(workItemId, limit = 50) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM run_insights WHERE work_item_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(workItemId, limit);
}

export function getInsightById(id) {
  if (id == null) return null;
  const db = getDb();
  return db.prepare(`SELECT * FROM run_insights WHERE id = ?`).get(id) || null;
}

export function getPendingInsightPromotions({ limit = 100 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM run_insights
    WHERE promotion_status = 'pending'
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}

export function hasPromotedInsightMemories() {
  const db = getDb();
  const row = db.prepare(`
    SELECT 1 AS ok
    FROM run_insights
    WHERE promotion_status IN ('promoted', 'duplicate')
      OR (promoted_memory_id IS NOT NULL AND trim(promoted_memory_id) != '')
    LIMIT 1
  `).get();
  return !!row;
}

/** Filter insight rows to those whose file_paths overlap with the given paths. */
function _filterByFilePaths(rows, targetPaths) {
  const targetSet = new Set(targetPaths.map(p => p.replace(/\\/g, "/")));
  return rows.filter(row => {
    if (!row.file_paths) return false;
    try {
      const paths = JSON.parse(row.file_paths);
      return paths.some(p => targetSet.has(p.replace(/\\/g, "/")));
    } catch {
      return false;
    }
  });
}
