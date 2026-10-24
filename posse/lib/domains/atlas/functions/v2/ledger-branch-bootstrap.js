// @ts-check
//
// Bootstrap of a ledger branch that a write names before it exists.
//
// Only the repository baseline (its default/target branch) is a root
// partition. Every other name, above all a work-item partition such as
// `wi-15`, is a fork of the baseline at the baseline's current head: that is
// how the waiting lane and the WI warm create them. An on-demand write that
// reached the ledger first (a dev job's edit refresh, a SCIP ingest with an
// explicit branch) used to create the missing branch as a second root. The
// later fork sites saw an existing branch and kept it, the storage contract
// then rightly refused to mark a root merged, and the partition stayed active
// after the product merge.

/**
 * @typedef {{
 *   getBranch: (name: string) => ({ parent_branch?: string | null } | null | undefined),
 *   headSeq: (name: string) => number,
 *   ensureRootBranch?: (name: string, opts?: { label?: string }) => Promise<unknown>,
 *   forkBranch?: (name: string, parentBranch: string, atSeq: number, opts?: { label?: string }) => Promise<unknown>,
 * }} BranchBootstrapLedger
 */

/**
 * Ensure `branch` exists for a write. An existing branch is returned as is.
 * A missing branch equal to the baseline (or a ledger with no baseline
 * named) becomes the root; any other missing branch forks from the baseline,
 * creating the baseline root first when the ledger is empty.
 *
 * @param {BranchBootstrapLedger} ledger
 * @param {string} branch
 * @param {{ baselineBranch?: string | null, label?: string }} [opts]
 * @returns {Promise<{ created: boolean, forked_from: { branch: string, seq: number } | null }>}
 */
export async function ensureLedgerBranchForWrite(ledger, branch, { baselineBranch = null, label = "ledger.ensureBranchForWrite" } = {}) {
  const name = String(branch || "").trim();
  if (!name) throw new TypeError("ensureLedgerBranchForWrite: branch is required");
  if (ledger.getBranch(name)) return { created: false, forked_from: null };
  const baseline = String(baselineBranch || "").trim();
  if (!baseline || baseline === name || typeof ledger.forkBranch !== "function") {
    if (typeof ledger.ensureRootBranch === "function") await ledger.ensureRootBranch(name, { label });
    return { created: true, forked_from: null };
  }
  if (!ledger.getBranch(baseline) && typeof ledger.ensureRootBranch === "function") {
    await ledger.ensureRootBranch(baseline, { label });
  }
  const seq = Number(ledger.headSeq(baseline)) || 0;
  await ledger.forkBranch(name, baseline, seq, { label });
  return { created: true, forked_from: { branch: baseline, seq } };
}
