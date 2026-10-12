// @ts-check
// Queue-backed target debt transitions; each update retains its transaction.
import { getWorkItem, updateWorkItemMetadata } from "../../queue/functions/index.js";
import { getDb } from "../../../shared/storage/functions/index.js";

/**
 * Append a failing check to a work item's target_debt (the work item whose
 * merge commit introduced it), or extend the matching entry's blocked work
 * items. Returns the stored entry, or null when the work item is gone.
 */
export function recordTargetDebt(workItemId, record) {
  let stored = null;
  getDb().transaction(() => {
    const row = getWorkItem(workItemId);
    if (!row) return;
    let metadata;
    try { metadata = JSON.parse(row.metadata_json || "{}"); } catch { metadata = {}; }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) metadata = {};
    const existing = Array.isArray(metadata.target_debt) ? metadata.target_debt : [];
    const prior = existing.find((item) => item.command === record.command
      && (item.failure_fingerprint || null) === (record.failure_fingerprint || null) && item.commit === record.commit);
    if (prior) {
      prior.blocked_work_item_ids = [...new Set([...(prior.blocked_work_item_ids || []), ...(record.blocked_work_item_ids || [])])];
      stored = prior;
    } else {
      stored = { ...record, blocked_work_item_ids: record.blocked_work_item_ids || [], recorded_at: new Date().toISOString() };
      existing.push(stored);
    }
    updateWorkItemMetadata(workItemId, { ...metadata, target_debt: existing });
  })();
  return stored;
}

/**
 * A merge whose candidate passed `command` (in `cwdRelative`) clears the
 * open target_debt entries for that check: the target no longer fails it.
 */
export function resolveTargetDebtEntries({ command, cwdRelative = null, workItemId, mergeHash }) {
  const resolved = [];
  getDb().transaction(() => {
    const rows = getDb().prepare(`
      SELECT id FROM work_items
      WHERE json_valid(metadata_json) AND json_extract(metadata_json, '$.target_debt') IS NOT NULL
    `).all();
    for (const { id } of rows) {
      const row = getWorkItem(id);
      let metadata;
      try { metadata = JSON.parse(row?.metadata_json || "{}"); } catch { continue; }
      const entries = Array.isArray(metadata?.target_debt) ? metadata.target_debt : [];
      let changed = false;
      for (const entry of entries) {
        if (entry.resolved_by || entry.command !== command || (entry.cwd_relative || null) !== (cwdRelative || null)) continue;
        if (entry.commit === mergeHash) continue;
        entry.resolved_by = { work_item_id: workItemId, commit: mergeHash, resolved_at: new Date().toISOString() };
        changed = true;
        resolved.push({ work_item_id: Number(id), command, commit: entry.commit });
      }
      if (changed) updateWorkItemMetadata(id, { ...metadata, target_debt: entries });
    }
  })();
  return resolved;
}
