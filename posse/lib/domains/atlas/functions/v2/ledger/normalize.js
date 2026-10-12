export { parseLedgerSymbolId as parseSymbolIdString } from "../symbol-id.js";
// @ts-check
//
// Stateless, cross-domain helpers shared by the ATLAS v2 Ledger wireframe and
// its domain stores (FeedbackStore, BlobStore, …). No DB handle, no state.

export function nowIso() {
  return new Date().toISOString();
}
