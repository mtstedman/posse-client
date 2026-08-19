import { normalizeRepoPath } from "./worktree-dirty-classification.js";

// Normalize only the persisted handoff contract. Git execution remains owned
// by the worktree lifecycle, which holds the corresponding locks.
export function pendingCrossWiFileSyncs(payload = {}) {
  return (Array.isArray(payload?._cross_wi_file_syncs) ? payload._cross_wi_file_syncs : [])
    .map((entry) => ({
      ...entry,
      path: normalizeRepoPath(entry?.path),
      source_branch: String(entry?.source_branch || "").trim(),
      source_work_item_id: Number(entry?.source_work_item_id),
    }))
    .filter((entry) => entry.path && entry.source_branch && Number.isFinite(entry.source_work_item_id));
}
