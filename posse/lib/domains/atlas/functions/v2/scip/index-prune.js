// @ts-check
//
// Superseded `scip_indexes` bookkeeping. A completed SCIP staging session
// that covered the full repository fileset commits one row per artifact; any
// other row of the same scheme describes an older fileset, config or indexer
// and can only serve as a stale skip key. This decides whether a session's
// intake proves a complete replacement, and which ids it committed.

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
 * @param {{
 *   staged: {
 *     reason?: string,
 *     results?: Array<{ ok?: boolean }>,
 *     unavailableDocuments?: Array<{ reason?: string }>,
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
  /** @type {Set<number>} */
  const ids = new Set();
  for (const report of intakeReports) {
    if (report?.ok !== true) return null;
    if (Array.isArray(report.failed_documents) && report.failed_documents.length > 0) return null;
    const id = report.scip_index_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
    ids.add(id);
  }
  return [...ids].sort((left, right) => left - right);
}
