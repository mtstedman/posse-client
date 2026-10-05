// Read-side view of deterministic test-execution receipts for merge
// decisions: which checks actually ran, and how they ended, on the exact
// commit about to be merged.

import { getDb } from "../../../shared/storage/functions/index.js";
import { getArtifact } from "./artifacts.js";
import {
  TEST_EXECUTION_RECEIPT_KIND,
  TEST_EXECUTION_RECEIPT_MIME_TYPE,
} from "../../../catalog/verification.js";

const COMMIT_RE = /^[0-9a-f]{40,64}$/;

function normalizedCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  return COMMIT_RE.test(commit) ? commit : null;
}

function parseReceipt(artifact) {
  if (!artifact?.content_json) return null;
  try {
    const parsed = typeof artifact.content_json === "string"
      ? JSON.parse(artifact.content_json)
      : artifact.content_json;
    return parsed?.kind === TEST_EXECUTION_RECEIPT_KIND ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The newest post-change receipt of each check (plan) that ran on exactly
 * `commitHash`, across every job of the work item, newest first.
 */
export function postChangeReceiptsAtCommit(workItemId, commitHash, { limit = 256 } = {}) {
  const commit = normalizedCommit(commitHash);
  if (!workItemId || !commit) return [];
  const rows = getDb().prepare(`
    SELECT id
    FROM artifacts
    WHERE work_item_id = ? AND mime_type = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(workItemId, TEST_EXECUTION_RECEIPT_MIME_TYPE, limit);
  const seenPlans = new Set();
  const receipts = [];
  for (const row of rows) {
    const artifact = getArtifact(row.id);
    const receipt = parseReceipt(artifact);
    if (receipt?.phase !== "post_change") continue;
    if (normalizedCommit(receipt.commit_hash) !== commit && normalizedCommit(receipt.executed_commit_hash) !== commit) continue;
    const planKey = String(receipt.plan_id || receipt.command || row.id);
    if (seenPlans.has(planKey)) continue;
    seenPlans.add(planKey);
    receipts.push({
      artifact_id: Number(row.id),
      job_id: artifact.job_id == null ? null : Number(artifact.job_id),
      command: String(receipt.command || "").slice(0, 300) || null,
      source: receipt.source || null,
      status: String(receipt.status || "unknown"),
      commit_hash: commit,
      test_counts: receipt.test_counts || null,
    });
  }
  return receipts;
}

/** The work item's newest dev/fix commit: what its branch head normally is. */
export function latestImplementationCommit(workItemId) {
  const row = getDb().prepare(`
    SELECT a.commit_hash
    FROM job_attempts a
    JOIN jobs j ON j.id = a.job_id
    WHERE j.work_item_id = ?
      AND j.job_type IN ('dev', 'fix')
      AND a.commit_hash IS NOT NULL
      AND TRIM(a.commit_hash) != ''
    ORDER BY a.id DESC
    LIMIT 1
  `).get(workItemId);
  return normalizedCommit(row?.commit_hash);
}
