// @ts-check
//
// Superseded `scip_indexes` bookkeeping. A completed SCIP staging session
// commits one row per artifact; after a full-fileset session any other row of
// the same scheme describes an older fileset, config or indexer and can only
// serve as a stale skip key (an incremental session reclaims less, see
// session-reclaim.js). This decides whether a session's intake proves a
// complete session, and which ids it committed.

/**
 * @typedef {{ ok?: boolean, failed_documents?: unknown[], scip_index_id?: number | null }} ScipIntakeReport
 */

/**
 * The committed `scip_indexes` ids of a staging session, or null when the
 * session is not a complete replacement. Fail closed: a partial/failed
 * session, a failed staging row, a document the session could not stage or
 * intake, an unacknowledged artifact, an artifact with failed documents, or
 * an artifact without a recorded id all keep every existing row.
 *
 * The stager reports a session `complete` even when a bisected batch dropped
 * a document, so its unavailable documents are checked here. The one typed
 * exception is a deterministic indexer syntax rejection: it fails the same
 * way on every restage, so it can never be replaced and must not pin the
 * superseded rows forever.
 *
 * A stale whole-project snapshot likewise fails a document whose file changed
 * under it (`range_clamped`) on every re-ingest. The warm restages that path
 * through this session's batches, so such a failure does not block the prune
 * once the session's manifest staged the path: in a complete session with no
 * other unavailable document, that path was acknowledged (or rejected for
 * syntax, which is exempt above).
 *
 * @param {{
 *   staged: {
 *     reason?: string,
 *     results?: Array<{ ok?: boolean }>,
 *     unavailableDocuments?: Array<{ reason?: string }>,
 *     manifest?: { batches?: Array<{ paths?: string[] }> } | null,
 *   } | null | undefined,
 *   intakeReports: Array<ScipIntakeReport | null | undefined>,
 * }} input
 * @returns {number[] | null}
 */
export function committedScipIndexIdsForPrune({ staged, intakeReports }) {
  if (staged?.reason !== "complete") return null;
  if ((staged.results || []).some((row) => row?.ok === false)) return null;
  if ((staged.unavailableDocuments || []).some((document) => (
    document?.reason !== "batch_document_unsupported_syntax"
  ))) return null;
  const sessionPaths = new Set((staged.manifest?.batches || []).flatMap((batch) => batch?.paths || []));
  /** @type {Set<number>} */
  const ids = new Set();
  for (const report of intakeReports) {
    if (report?.ok !== true) return null;
    const failed = Array.isArray(report.failed_documents) ? report.failed_documents : [];
    if (failed.some((document) => !restagedRangeDrift(document, sessionPaths))) return null;
    const id = report.scip_index_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
    ids.add(id);
  }
  return [...ids].sort((left, right) => left - right);
}

/**
 * @param {unknown} document
 * @param {Set<string>} sessionPaths
 */
function restagedRangeDrift(document, sessionPaths) {
  const failed = /** @type {{ reason?: unknown, repo_rel_path?: unknown } | null} */ (document);
  return failed?.reason === "range_clamped" && sessionPaths.has(String(failed.repo_rel_path || ""));
}
