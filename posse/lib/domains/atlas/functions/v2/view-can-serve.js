// @ts-check
//
// ATLAS v2 view-eligibility helper. Pure predicate deciding whether an
// already-built view's meta can serve a given branch — combining build-mode
// freshness, fork-parent-at-seq allowances, and ledger freshness. Reads only
// its arguments (meta + the ledger handle threaded in by the caller).

import { viewFreshness } from "./view-health.js";

/** @typedef {import("../../classes/v2/Ledger.js").Ledger} Ledger */

/**
 * @param {{ meta: any, ledger: Ledger, branch: string, allowParentBranchAtSeq?: number | null, parentBranch?: string, layerMerge?: boolean | null }} args
 * @returns {{ ok: boolean, reason?: string }}
 */
export function viewCanServeBranch({ meta, ledger, branch, allowParentBranchAtSeq = null, parentBranch = "main", layerMerge = null }) {
  const modeFreshness = viewFreshness(meta, null, { layerMerge });
  if (!modeFreshness.current) {
    return { ok: false, reason: modeFreshness.reason || "view build mode is stale" };
  }
  if (allowParentBranchAtSeq != null && meta?.branch === parentBranch) {
    return Number(meta.ledger_seq) === allowParentBranchAtSeq
      ? { ok: true }
      : { ok: false, reason: `${parentBranch} view seq ${Number(meta.ledger_seq) || 0} does not match fork parent ${allowParentBranchAtSeq}` };
  }
  if (!meta || meta.branch !== branch) {
    return { ok: false, reason: `view branch '${meta?.branch || "unknown"}' does not match '${branch}'` };
  }
  const freshness = viewFreshness(meta, ledger, { layerMerge });
  return freshness.current ? { ok: true } : { ok: false, reason: freshness.reason || "view is stale" };
}
