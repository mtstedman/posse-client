// @ts-check
//
// Conductor-side retrieval dispatch: runs a read-only ATLAS v2 tool call in
// the conductor thread so the synchronous better-sqlite3 work (graph walks,
// tree scoring, skeleton assembly) never blocks the orchestrator event loop.
//
// Handles are REQUEST-SCOPED on purpose: a cached read handle on the view
// would block #rebuildBranchView's removeSqliteFile on Windows (open handle →
// EPERM unlink) and can dangle across the rebuild's file swap. Opening a
// readonly WAL connection costs ~a millisecond — negligible next to the
// dispatch itself.

import { View } from "../../../classes/v2/View.js";
import { Ledger } from "../../../classes/v2/Ledger.js";
import { dispatch } from "../retrieval/index.js";

/**
 * @param {{
 *   call: Record<string, unknown>,
 *   viewPath: string,
 *   ledgerPath?: string | null,
 *   versionId: string,
 *   readRoot?: string | null,
 *   repoId?: string | null,
 *   config?: Record<string, unknown> | null,
 * }} payload
 */
export async function runConductorRetrieve(payload) {
  const viewPath = String(payload?.viewPath || "");
  if (!viewPath) throw new Error("conductor retrieve requires viewPath");
  /** @type {any} */
  let view = null;
  /** @type {any} */
  let ledger = null;
  try {
    view = View.mount({ dbPath: viewPath, mode: "readonly" });
    if (payload.ledgerPath) {
      try {
        ledger = Ledger.open({ dbPath: String(payload.ledgerPath) });
      } catch {
        // Ledger is optional for pure view reads; dispatch surfaces a
        // structured error for the actions that genuinely need it.
        ledger = null;
      }
    }
    const envelope = await Promise.resolve(dispatch(/** @type {any} */ (payload.call), {
      view,
      ledger,
      versionId: String(payload.versionId || ""),
      repoRoot: payload.readRoot ? String(payload.readRoot) : undefined,
      repoId: payload.repoId ? String(payload.repoId) : null,
      config: payload.config && typeof payload.config === "object" ? payload.config : {},
    }));
    // Envelopes are JSON-safe by contract; round-trip defensively so a stray
    // non-clonable never kills the daemon transport.
    return JSON.parse(JSON.stringify(envelope));
  } finally {
    try { ledger?.close?.(); } catch { /* ignore */ }
    try { view?.close?.(); } catch { /* ignore */ }
  }
}
