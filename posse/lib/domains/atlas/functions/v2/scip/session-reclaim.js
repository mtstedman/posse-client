// @ts-check
//
// Reclaim what a completed SCIP batch staging session superseded: the
// `scip_indexes` bookkeeping rows and the batch session directories. Both are
// skip keys or reusable cache only, so every failure keeps the previous state
// and the next completed session retries.
//
// A full-fileset session replaces everything of the schemes it committed and
// records what it leaves as the reclaim anchor. An incremental session covers
// a subset: it removes only what earlier incremental sessions left, never
// anything the anchor names, so the table holds at most the anchor plus the
// latest incremental set and the batches dir at most the anchor's sessions
// plus the latest incremental session (and its reuse owners).

import { committedScipIndexIdsForPrune } from "./index-prune.js";
import { collectScipBatchSessions, listScipBatchSessionIds } from "./batch-session-gc.js";

/** @typedef {import("../../../classes/v2/ledger/ScipIndexStore.js").ScipReclaimAnchor} ScipReclaimAnchor */
/** @typedef {import("./batch-session-gc.js").ScipBatchSessionGcResult} ScipBatchSessionGcResult */

/**
 * @typedef {{
 *   skipped: string | null,
 *   rows: { deleted: number, schemes: string[] } | null,
 *   rowError: unknown,
 *   anchor: ScipReclaimAnchor | null,
 *   sessions: ScipBatchSessionGcResult | null,
 * }} ScipReclaimReport
 */

/**
 * @param {{
 *   ledger: Pick<import("../../../classes/v2/Ledger.js").Ledger, "pruneSupersededScipIndexes" | "pruneIncrementalScipIndexes">,
 *   scipDir: string,
 *   staged: Parameters<typeof committedScipIndexIdsForPrune>[0]["staged"] & {
 *     sessionId?: string | null,
 *     resumedFromSessions?: string[],
 *   },
 *   intakeReports: Parameters<typeof committedScipIndexIdsForPrune>[0]["intakeReports"],
 *   scope: "full" | "incremental",
 *   nowMs?: number,
 * }} input
 * @returns {Promise<ScipReclaimReport>}
 */
export async function reclaimSupersededScipState({ ledger, scipDir, staged, intakeReports, scope, nowMs }) {
  /** @type {ScipReclaimReport} */
  const report = { skipped: null, rows: null, rowError: null, anchor: null, sessions: null };
  const keepIds = committedScipIndexIdsForPrune({ staged, intakeReports });
  if (!keepIds) return { ...report, skipped: "session_not_complete" };
  const currentSessionId = String(staged?.sessionId || "");

  if (scope === "full") {
    try {
      const pruned = ledger.pruneSupersededScipIndexes(keepIds, {
        anchorSessions: [currentSessionId, ...(staged?.resumedFromSessions || [])],
      });
      report.rows = { deleted: pruned.deleted, schemes: pruned.schemes };
      report.anchor = pruned.anchor;
    } catch (err) {
      report.rowError = err;
    }
    report.sessions = await collectScipBatchSessions({ scipDir, currentSessionId, nowMs });
    return report;
  }

  // The session dirs present before this one seed a bootstrap anchor, so an
  // unreadable batches root must stop the reclaim before the ledger records one.
  const present = await listScipBatchSessionIds(scipDir);
  if (!present) return { ...report, skipped: "batches_root_unreadable" };
  try {
    const pruned = ledger.pruneIncrementalScipIndexes(keepIds, {
      presentSessions: present.filter((sessionId) => sessionId !== currentSessionId),
    });
    report.rows = { deleted: pruned.deleted, schemes: pruned.schemes };
    report.anchor = pruned.anchor;
  } catch (err) {
    return { ...report, rowError: err, skipped: "anchor_unavailable" };
  }
  // Without the anchor the full session's dirs cannot be told apart.
  if (!report.anchor) return { ...report, skipped: "anchor_unavailable" };
  report.sessions = await collectScipBatchSessions({
    scipDir,
    currentSessionId,
    retainedSessionIds: report.anchor.sessions,
    nowMs,
  });
  return report;
}
