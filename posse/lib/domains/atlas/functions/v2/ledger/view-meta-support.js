// @ts-check



export function ledgerSupportsViewMeta(ledger, viewMeta) {
  const branch = typeof viewMeta?.branch === "string" && viewMeta.branch ? viewMeta.branch : null;
  if (!ledger || !branch || typeof ledger.getBranch !== "function") return true;
  try {
    return !!ledger.getBranch(branch);
  } catch {
    return false;
  }
}
